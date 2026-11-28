import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import { RedisService } from '../../../common/redis';
import type { JwtUser } from '../../../common/decorators/user.decorator.ts';
import { AnalyticsService } from './analytics.service.ts';
import type { AiAnalyticsPlanInput } from '../intent/intent.types.ts';
import {
  RUN_EVENT_TTL_MS,
  STALE_RUN_MS,
  STREAM_POLL_MS,
  isRunTerminal,
  parseResumeFrom,
  parseRunEvent,
  serializeRunEvent,
  sseFrame,
  type ChatRunStatus,
} from './chat-run-events.ts';

/**
 * AI 问数的「后台 run」：把生成从 HTTP 请求生命周期里摘出来（2026-11-24，借 ApeAdmin 的 runner）。
 *
 * 要解决的三个真问题：
 *   ① 关页/断网 = 白问。P3-B 的流式绑在请求上，`res` 一断生成就没了；
 *   ② 代理缓冲/弱网会把长连接掐在中途，用户只看到半截文字还以为系统崩了；
 *   ③ 生成中刷新页面，答案彻底找不回来（历史记录里只有跑完之后才存在的报告）。
 *
 * 形态：`create` 落一行 pending 后**立即返回 runId**，生成在服务端跑完并落库；
 * 前端只是订阅者，断线重连带 `from=<已看事件数>` 续传。事件流本体在 Redis（2h TTL），
 * 库里只留终态快照——所以进程重启/Redis 丢了也只是「不能逐字重放」，结果本身不丢。
 *
 * 与 ApeAdmin 的差异：它把事件缓冲放在**进程内 asyncio 队列**（自陈「单 worker 假设」），
 * 我们放 Redis，多实例时任意一台都能续传（本项目 Redis 是可选的，没配就退化成进程内，
 * 此时等价于它的单实例语义——这条取舍写在这里，别以为配不配 Redis 都一样）。
 */
@Injectable()
export class ChatRunService implements OnModuleInit {
  private readonly logger = new Logger(ChatRunService.name);
  /** 每 run 的写入串行链：事件必须按序 rpush，否则 delta 会串字 */
  private readonly chains = new Map<string, Promise<void>>();
  /** 每 run 已产出事件数的本地计数（用于决定多久往库里刷一次 eventCount） */
  private readonly emitted = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: RedisService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * 启动清理：内存里的执行器随进程没了，但库里的行还停在 pending/running。
   * 判定「死」的标准是 `updatedAt` 超过 `STALE_RUN_MS` 没动——多实例下也不会误杀别人正在跑的 run。
   */
  async onModuleInit(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);
    try {
      const res = await this.prisma.aiChatRun.updateMany({
        where: { status: { in: ['pending', 'running'] }, updatedAt: { lt: cutoff } },
        data: {
          status: 'failed',
          error: '服务重启，这次生成已中断；请重新提问',
          finishedAt: new Date(),
        },
      });
      if (res.count) this.logger.warn(`已清理 ${res.count} 个遗留的僵尸 run（进程重启导致）`);
    } catch (e) {
      this.logger.error(`清理僵尸 run 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private eventsKey(runId: string): string {
    return 'ai:run:' + runId + ':events';
  }
  private stopKey(runId: string): string {
    return 'ai:run:' + runId + ':stop';
  }

  /** 串行化同一 run 的事件写入（rpush 顺序 = 事件顺序） */
  private enqueue(runId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(runId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.chains.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** 取 run 并做归属校验：非本人且非超管一律 404（不暴露「这个 id 存在」） */
  private async load(runId: string, projectId: string, user: JwtUser) {
    const row = await this.prisma.aiChatRun.findFirst({ where: { id: runId, projectId } });
    if (!row) throw new NotFoundException('这次问答不存在');
    const mine = row.createdBy && String(row.createdBy) === String(user?.userId);
    if (!mine && !user?.isSuperAdmin) throw new NotFoundException('这次问答不存在');
    return row;
  }

  /** 建 run 并**立刻返回**：生成在后台跑，前端拿 runId 去订阅 */
  async create(body: AiAnalyticsPlanInput, projectId: string, user: JwtUser) {
    const question = String((body as { question?: unknown })?.question ?? '').trim();
    const row = await this.prisma.aiChatRun.create({
      data: {
        projectId,
        createdBy: user?.userId ?? null,
        createdByName: user?.realName || user?.username || null,
        question,
        status: 'pending',
      },
    });
    // 故意不 await：HTTP 响应必须马上回去，用户才看得到「正在生成」
    void this.execute(row.id, body, projectId, user);
    return { runId: row.id, status: 'pending' as ChatRunStatus };
  }

  /** 终态快照（断线重连/刷新页面后先取它，再决定要不要续传） */
  async snapshot(runId: string, projectId: string, user: JwtUser) {
    const row = await this.load(runId, projectId, user);
    const buffered = await this.redis.listLength(this.eventsKey(runId));
    return {
      runId: row.id,
      status: row.status,
      question: row.question,
      answer: row.answerText ?? '',
      accepted: row.accepted ?? null,
      warnings: (row.warningsJson as string[] | null) ?? [],
      toolTrace: (row.toolTraceJson as unknown[] | null) ?? [],
      discardedNumbers: (row.discardedJson as number[] | null) ?? [],
      reportId: row.reportId ?? null,
      error: row.error ?? null,
      /** 还能拿到多少条可重放事件（0 = 缓冲已过期，只能看快照结论） */
      bufferedEvents: buffered,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  /**
   * 请求中断：置标记，执行器在收尾时**跳过落库**并把已生成的部分答案留下。
   * 不做「立刻 kill LLM 流」——streamChat 没有暴露 abort，硬造会造成半条数据；
   * 这里选择「停止=不写库」，比「假装停掉却仍写了一条报告」更诚实。
   */
  async stop(runId: string, projectId: string, user: JwtUser) {
    const row = await this.load(runId, projectId, user);
    if (isRunTerminal(row.status)) return { runId, status: row.status };
    await this.redis.set(this.stopKey(runId), '1', 10 * 60_000);
    return { runId, status: 'stopping' as const };
  }

  /** SSE 订阅：从 `from`（已看事件数）开始补，收满即断 */
  async stream(
    runId: string,
    projectId: string,
    user: JwtUser,
    fromRaw: unknown,
    res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let from = parseResumeFrom(fromRaw);
    let lastWrite = Date.now();
    /** 最近一次写出去的事件名：终态收尾时避免重复发 done（缓冲里可能已经有一条） */
    let lastEvent = '';
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && Date.now() - lastWrite >= 15000) {
        res.write(': ping\n\n');
        lastWrite = Date.now();
      }
    }, 5000);

    try {
      // 先过一次归属校验（不存在/不属于本人都按 404 处理），再进订阅循环
      await this.load(runId, projectId, user);
      // 冷启动就能看见「已跑完」的场景（刷新页面后重连）：直接给快照
      for (;;) {
        const buffered = await this.redis.listRange(this.eventsKey(runId), from, -1);
        for (const raw of buffered) {
          const ev = parseRunEvent(raw);
          if (!ev) continue;
          res.write(sseFrame(ev.event, ev.data));
          lastEvent = ev.event;
          from += 1;
          lastWrite = Date.now();
        }
        const row = await this.prisma.aiChatRun.findUnique({
          where: { id: runId },
          select: { status: true, answerText: true, accepted: true, reportId: true, error: true, warningsJson: true, toolTraceJson: true, discardedJson: true },
        });
        if (!row) {
          res.write(sseFrame('error', { message: '这次问答已不存在' }));
          break;
        }
        if (isRunTerminal(row.status)) {
          // 事件缓冲过期/进程重启（Redis 降级或 TTL 到期）时，用库里的快照补一个 final：
          // 否则用户会看到「done 但一个字都没有」的空白结论。
          if (from === 0) {
            res.write(
              sseFrame('final', {
                accepted: row.accepted === true,
                answer: row.answerText ?? '',
                discardedNumbers: (row.discardedJson as number[] | null) ?? [],
                warnings: (row.warningsJson as string[] | null) ?? [],
                toolTrace: (row.toolTraceJson as unknown[] | null) ?? [],
                replayedFromSnapshot: true,
              }),
            );
          }
          if (lastEvent !== 'done') {
            res.write(
              sseFrame('done', {
                runId,
                status: row.status,
                reportId: row.reportId ?? null,
                error: row.error ?? null,
                replayedFromSnapshot: from === 0,
              }),
            );
          }
          break;
        }
        await new Promise((r) => setTimeout(r, STREAM_POLL_MS));
        if (Date.now() - lastWrite > 10 * 60_000) {
          res.write(sseFrame('error', { message: '等待生成超时，请刷新页面查看结果' }));
          break;
        }
      }
    } catch (e) {
      res.write(sseFrame('error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
      this.chains.delete(runId);
      this.emitted.delete(runId);
    }
  }

  /** 后台执行：跑完整条问数链路，把事件写进缓冲、终态写进库 */
  private async execute(
    runId: string,
    body: AiAnalyticsPlanInput,
    projectId: string,
    user: JwtUser,
  ): Promise<void> {
    let partial = '';
    const emit = (event: string, data: unknown): void => {
      if (event === 'delta') {
        const text = String((data as { text?: unknown })?.text ?? '');
        partial += text;
      }
      void this.enqueue(runId, async () => {
        await this.redis.rpush(this.eventsKey(runId), serializeRunEvent(event, data), RUN_EVENT_TTL_MS);
        const n = (this.emitted.get(runId) ?? 0) + 1;
        this.emitted.set(runId, n);
        // 每 20 条事件刷一次 eventCount（顺带刷新 updatedAt 作为心跳）：逐字写库太贵。
        // ⚠️ 这里**不许改 status**：终态由 execute() 独占写入，否则 done 会被这行打回 running
        // （真踩过：报告已落库、answerText 也有值，快照里状态还是 running）。
        if (n % 20 === 0 || event !== 'delta') {
          await this.prisma.aiChatRun
            .update({ where: { id: runId }, data: { eventCount: n } })
            .catch(() => undefined);
        }
      });
    };

    try {
      await this.prisma.aiChatRun.update({
        where: { id: runId },
        data: { status: 'running', startedAt: new Date() },
      });
      const result = await this.analytics.streamAsk(body, projectId, user, emit);
      const stoppedByUser = await this.redis.get(this.stopKey(runId));
      if (stoppedByUser) {
        // 用户点了停止：**不落报告**（那会让「已停止」凭空多出一条问答记录），只留部分答案
        emit('stopped', { runId, partialAnswer: partial });
        await this.prisma.aiChatRun.update({
          where: { id: runId },
          data: {
            status: 'stopped',
            answerText: partial.slice(0, 20000),
            accepted: false,
            finishedAt: new Date(),
          },
        });
        return;
      }
      await this.prisma.aiChatRun.update({
        where: { id: runId },
        data: {
          status: 'done',
          answerText: result.answer ?? partial,
          accepted: result.accepted ?? null,
          warningsJson: (result.warnings ?? []) as unknown as object,
          toolTraceJson: (result.toolTrace ?? []) as unknown as object,
          discardedJson: (result.discardedNumbers ?? []) as unknown as object,
          reportId: result.id ?? null,
          finishedAt: new Date(),
        },
      });
      emit('done', { runId, status: 'done', reportId: result.id ?? null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`问数 run ${runId} 失败：${message}`);
      await this.prisma.aiChatRun
        .update({ where: { id: runId }, data: { status: 'failed', error: message, finishedAt: new Date() } })
        .catch(() => undefined);
      emit('error', { message });
      emit('done', { runId, status: 'failed', error: message });
    }
  }
}
