import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { paginate, buildResult } from '../utils/helpers';
import { StorageService } from './storage.service';
import { ImportOutcome, ImportRowError, ImportRunnerService, RunOptions } from './import-runner.service';
import { NotificationService } from '../../modules/notification/notification.service';
import {
  IMPORT_ACTIVE_STATUSES,
  IMPORT_TASK_STALE_MESSAGE,
  importDedupeKey,
  isImportTaskStale,
} from '../utils/import-task';

/** 超过该行数走异步导入（需求 2.7） */
export const ASYNC_IMPORT_THRESHOLD = 1000;

/** 僵尸巡检间隔 = 僵尸阈值的一半（10 分钟阈值 → 5 分钟巡检一次） */
const IMPORT_TASK_STALE_MS_HALF = 5 * 60 * 1000;

export interface SubmitContext {
  module: string;
  moduleName: string;
  fileName?: string;
  projectId?: string;
  userId?: string;
  username?: string;
}

/**
 * 异步导入任务服务（需求 2.7）
 *
 * - ≤ 阈值行数：同步执行，直接返回结果
 * - > 阈值行数：立即返回 taskId，后台执行，可轮询进度、完成后站内通知、失败行可下载错误报告
 * - **崩溃恢复**：执行期间持续刷新 `lockedAt` 心跳；启动时与定时回收「长时间无心跳」的
 *   PENDING/RUNNING 任务（置 FAILED 并提示重新导入），避免进程崩溃后任务永久卡在进行中
 * - **幂等去重**：同一份文件（模块+文件名+行数+内容摘要）在 PENDING/RUNNING 期间重复提交时，
 *   直接返回既有 taskId，不再新建任务（挡双击与网络重试；已完成的任务不阻止再次导入同一文件）
 */
@Injectable()
export class ImportTaskService implements OnModuleInit {
  /** 僵尸回收定时器（unref：不阻止进程退出） */
  private reapTimer?: ReturnType<typeof setInterval>;

  constructor(
    private prisma: PrismaClient,
    private runner: ImportRunnerService,
    private notifier: NotificationService,
    private storage: StorageService,
  ) {}

  onModuleInit(): void {
    // 启动即回收一次（上一条进程留下的僵尸），随后按阈值一半的间隔巡检
    void this.reapStaleTasks();
    this.reapTimer = setInterval(() => void this.reapStaleTasks(), IMPORT_TASK_STALE_MS_HALF);
    this.reapTimer.unref?.();
  }

  /**
   * 回收僵尸导入任务：把「长时间无心跳」的 PENDING/RUNNING 任务置为 FAILED。
   * 判据是纯函数 `isImportTaskStale()`（启动时与定时各调一次；无僵尸时为空更新）。
   */
  async reapStaleTasks(): Promise<number> {
    try {
      const now = new Date();
      const rows = await this.prisma.importTask.findMany({
        where: { status: { in: [...IMPORT_ACTIVE_STATUSES] } },
        select: {
          id: true,
          status: true,
          lockedAt: true,
          startedAt: true,
          createdAt: true,
          userId: true,
          moduleName: true,
          fileName: true,
          projectId: true,
          totalRows: true,
        },
      });
      const stale = rows.filter((r) => isImportTaskStale(r, now));
      if (!stale.length) return 0;
      /**
       * 用「快照 CAS」而不是只按 id 更新（第 13/14 轮审计）：
       * 原来 `updateMany({ where: { id: { in } } })` 没有 status/lockedAt 条件，判定与写入
       * 之间没有任何隔离 —— 心跳恰在窗口内刷新、或任务正好写完并置成 SUCCESS，都会被
       * 覆盖成 FAILED「未写入任何数据」。而导库没有行级幂等键，用户照提示重导就是
       * **重复写入且不可逆**。这里把快照里的 status + lockedAt 一起放进 where：
       * 行一旦变过就更新不上（count = 0），只对真正回收成功的行发通知。
       */
      const reaped: typeof stale = [];
      for (const task of stale) {
        const res = await this.prisma.importTask.updateMany({
          where: { id: task.id, status: task.status, lockedAt: task.lockedAt },
          data: { status: 'FAILED', message: IMPORT_TASK_STALE_MESSAGE, finishedAt: now },
        });
        if (res.count > 0) reaped.push(task);
      }
      if (!reaped.length) return 0;
      // 补发失败通知：否则提交人只会看到「任务消失/卡住」，不知道要重新导入
      for (const task of reaped) {
        // 没有提交人就别写孤儿通知（userId=null 的行永远查不到），但要留痕
        if (!task.userId) {
          console.warn('[import-task] 僵尸任务无提交人，跳过站内通知：', task.id);
          continue;
        }
        try {
          await this.notifier.send({
            userId: task.userId,
            title: `【${task.moduleName || '导入'}】导入中断`,
            content: `文件「${task.fileName || '-'}」的导入任务因服务重启或超时被中断，未写入任何数据，请重新导入。`,
            type: 'ERROR',
            projectId: task.projectId || undefined,
            bizType: 'import-task',
            bizId: task.id,
          });
        } catch (e) {
          // 通知失败不阻断回收，但不能静默（第 13/14 轮审计）
          console.error('[import-task] 僵尸任务回收通知发送失败：', task.id, e);
        }
      }
      console.warn(
        '[import-task] 已回收僵尸导入任务',
        reaped.length,
        '个：',
        reaped.map((r) => r.id).join(', '),
      );
      return reaped.length;
    } catch (e) {
      // 回收失败不影响服务启动
      console.error('[import-task] 回收僵尸任务失败:', e);
      return 0;
    }
  }

  async list(query: any = {}, user?: any) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.module) where.module = query.module;
    if (query.status) where.status = query.status;
    if (user && !user.isSuperAdmin) where.userId = user.userId;
    const [list, total] = await Promise.all([
      this.prisma.importTask.findMany({ where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      this.prisma.importTask.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  /** 详情按提交人隔离（list 同口径）：错误报告 Excel 含业务行数据，不能跨用户拉取 */
  async findOne(id: string, userId?: string) {
    const t = await this.prisma.importTask.findFirst({
      where: { id, ...(userId ? { userId } : {}) },
    });
    if (!t) throw new NotFoundException('导入任务不存在');
    return t;
  }

  /** 提交导入任务：小批量同步返回，大批量异步执行 */
  async submit<T>(
    ctx: SubmitContext,
    rows: any[],
    opts: RunOptions<T>,
    validateOnly = false,
  ): Promise<ImportOutcome & { taskId?: string; async?: boolean; deduped?: boolean }> {
    if (!Array.isArray(rows)) throw new BadRequestException('导入内容为空');
    // 预校验模式：始终同步执行，不创建导入任务
    if (validateOnly) return this.runner.run(rows, { ...opts, validateOnly: true });
    if (rows.length <= ASYNC_IMPORT_THRESHOLD) return this.runner.run(rows, opts);

    // 幂等：同一份文件仍在处理中 → 直接返回既有任务，避免双击/重试产生重复导入。
    // ⚠️ 「先查后建」存在竞态（两个并发提交都查不到、都建行）——而双击恰恰就是并发，
    //    故用一个 PG **事务级咨询锁**（键 = dedupeKey 的哈希）把相同文件的提交串行化：
    //    后到的请求会等前者提交后再查，从而必然看见新行。
    const dedupeKey = importDedupeKey({ module: ctx.module, projectId: ctx.projectId, fileName: ctx.fileName, rows });
    const picked = await this.prisma.$transaction(async (tx) => {
      // 用 $executeRaw 而非 $queryRaw：pg_advisory_xact_lock 返回 void，
      // Prisma 的 $queryRaw 会尝试反序列化该列并报 'Failed to deserialize column of type void'
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dedupeKey})::bigint)`;
      const active = await tx.importTask.findFirst({
        where: { dedupeKey, status: { in: [...IMPORT_ACTIVE_STATUSES] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (active) return { id: active.id, deduped: true };
      const created = await tx.importTask.create({
        data: {
          module: ctx.module,
          moduleName: ctx.moduleName,
          fileName: ctx.fileName,
          totalRows: rows.length,
          dedupeKey,
          status: 'PENDING',
          projectId: ctx.projectId,
          userId: ctx.userId,
          username: ctx.username,
        },
        select: { id: true },
      });
      return { id: created.id, deduped: false };
    });
    if (picked.deduped) {
      // ⚠️ 去重命中时**绝不能**再跑一次 execute：否则两次执行并发写同一批数据，
      //    后者会撞唯一约束并把任务置为 FAILED（而数量却是前者写成功的）——已实测踩到。
      console.warn('[import-task] 相同文件正在处理中，复用既有任务:', picked.id);
    } else {
      // 后台执行：不阻塞请求
      void this.execute(picked.id, rows, opts, ctx).catch(() => undefined);
    }
    return {
      total: rows.length,
      created: 0,
      updated: 0,
      errors: [],
      taskId: picked.id,
      async: true,
      ...(picked.deduped ? { deduped: true } : {}),
    };
  }

  /** 后台执行导入并更新任务状态 */
  private async execute<T>(taskId: string, rows: any[], opts: RunOptions<T>, ctx: SubmitContext) {
    await this.prisma.importTask.update({
      where: { id: taskId },
      data: { status: 'RUNNING', startedAt: new Date(), lockedAt: new Date() },
    });
    let outcome: ImportOutcome;
    try {
      outcome = await this.runner.run(rows, {
        ...opts,
        /**
         * ⚠️ 任务终态必须与业务写入在**同一个事务**里落库。
         * 若在事务提交之后才置 SUCCESS，进程死在两者之间会留下「数据已写、任务仍 RUNNING」，
         * 僵尸回收会把它置 FAILED 并提示重新导入 → 日报这类没有行级幂等键的导入会重复写入。
         * 现在要么数据与 SUCCESS 一起提交，要么一起回滚；reapStaleTasks 见到的 RUNNING 一定没提交过。
         */
        write: async (plans: any[], tx: any) => {
          const res = await opts.write(plans, tx);
          await tx.importTask.update({
            where: { id: taskId },
            data: {
              status: 'SUCCESS',
              processedRows: rows.length,
              successCount: (res?.created || 0) + (res?.updated || 0),
              failCount: 0,
              message: null,
              finishedAt: new Date(),
            },
          });
          return res;
        },
        onProgress: async (processed: number) => {
          // 进度 + 心跳一起刷新（心跳用于崩溃/超时判定）；更新失败不阻断导入
          await this.prisma.importTask
            .update({ where: { id: taskId }, data: { processedRows: processed, lockedAt: new Date() } })
            .catch(() => undefined);
        },
      });
    } catch (e: any) {
      await this.prisma.importTask.update({
        where: { id: taskId },
        data: { status: 'FAILED', message: e?.message || String(e), finishedAt: new Date() },
      });
      await this.syncOperationLog(taskId, { rows: rows.length, success: 0, fail: rows.length, errorFileUrl: null });
      await this.notify(ctx, 'FAILED', 0, rows.length, taskId);
      return;
    }

    let errorFileUrl: string | null = null;
    if (outcome.errors.length) {
      errorFileUrl = await this.writeErrorReport(taskId, outcome.errors);
    }
    await this.prisma.importTask.update({
      where: { id: taskId },
      data: {
        status: outcome.errors.length ? 'FAILED' : 'SUCCESS',
        processedRows: rows.length,
        successCount: outcome.created + outcome.updated,
        failCount: outcome.errors.length,
        errorFileUrl,
        message: outcome.errors.length ? `${outcome.errors.length} 行校验失败，已全部回滚` : null,
        finishedAt: new Date(),
      },
    });
    await this.syncOperationLog(taskId, {
      rows: rows.length,
      success: outcome.created + outcome.updated,
      fail: outcome.errors.length,
      errorFileUrl,
    });
    await this.notify(ctx, outcome.errors.length ? 'FAILED' : 'SUCCESS', outcome.created + outcome.updated, outcome.errors.length, taskId);
  }

  /**
   * 回填操作日志的导入统计。
   * 异步导入在响应返回时只有 taskId（`created/updated/errors` 全是占位 0），
   * 拦截器按 `bizId = taskId` 记了那条日志；任务结束后在这里把真实行数/错误报告地址补上，
   * 否则大文件导入在审计日志里永远是「成功 0、失败 0」。
   */
  private async syncOperationLog(
    taskId: string,
    data: { rows: number; success: number; fail: number; errorFileUrl: string | null },
  ): Promise<void> {
    try {
      await this.prisma.operationLog.updateMany({
        where: { bizId: taskId },
        data: {
          importRows: data.rows,
          successCount: data.success,
          failCount: data.fail,
          errorFileUrl: data.errorFileUrl,
        } as any,
      });
    } catch {
      /* 日志回填失败不影响导入结果 */
    }
  }

  private async notify(ctx: SubmitContext, status: string, success: number, fail: number, taskId: string) {
    try {
      await this.notifier.send({
        userId: ctx.userId,
        title: `【${ctx.moduleName}】导入${status === 'SUCCESS' ? '完成' : '失败'}`,
        content:
          status === 'SUCCESS'
            ? `文件「${ctx.fileName || '-'}」导入完成，成功写入 ${success} 行。`
            : `文件「${ctx.fileName || '-'}」导入未完成，${fail} 行校验失败，已全部回滚，未写入任何数据。可下载错误报告核对。`,
        type: status === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
        projectId: ctx.projectId,
        bizType: 'import-task',
        bizId: taskId,
      });
    } catch {
      /* 通知失败不阻断 */
    }
  }

  /** 生成错误报告 Excel（行号 + 错误字段 + 错误描述），返回相对下载地址（落盘走 StorageService） */
  private async writeErrorReport(taskId: string, errors: ImportRowError[]): Promise<string> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('错误明细');
    ws.columns = [
      { header: '行号', key: 'row', width: 10 },
      { header: '错误字段', key: 'field', width: 24 },
      { header: '错误描述', key: 'message', width: 70 },
    ];
    errors.forEach((e) => ws.addRow({ row: e.row, field: e.field || '', message: e.message }));
    ws.getRow(1).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    const saved = await this.storage.save(Buffer.from(buf), {
      sub: 'import-errors',
      name: `import-errors-${taskId}.xlsx`,
    });
    return saved.url;
  }
}
