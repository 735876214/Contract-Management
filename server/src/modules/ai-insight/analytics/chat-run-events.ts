/**
 * AI 问数「后台 run」的事件流原语（**零依赖纯函数**，可被 `.mts` 单测直接加载）。
 *
 * 为什么要拆出来（2026-11-24，借 ApeAdmin 的 run 架构）：断线续传的核心是「事件带绝对序号、
 * 客户端报『我已看到第 N 个』、服务端只补后面的」。这套编号/序列化规则一旦与服务层混写，
 * 就只能靠起库起服务才测得了；拆成纯函数后，边界（负数/脏数据/越界）能在毫秒级锁住。
 */

export type ChatRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'stopped';

/** 终态：不再产生新事件，续传时补完余量即可收流 */
const TERMINAL: ReadonlySet<string> = new Set<ChatRunStatus>(['done', 'failed', 'stopped']);

/** 事件缓冲在 Redis 里的存活时间：够用户刷新/断网重连，又不至于长期占内存 */
export const RUN_EVENT_TTL_MS = 2 * 60 * 60 * 1000;
/** 订阅端轮询间隔：生成中每 300ms 拉一次增量（比这更密没有意义，模型出字没那么快） */
export const STREAM_POLL_MS = 300;
/**
 * 僵尸 run 判定：进程重启后内存里的执行器没了，但库里的行还是 running。
 * 2 分钟没有任何事件写入（`updatedAt` 不前进）就认定它死了——见 `recoverStaleRuns`。
 */
export const STALE_RUN_MS = 2 * 60 * 1000;

export function isRunTerminal(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL.has(status);
}

/** 一个事件的持久化形态（Redis 列表元素） */
export interface RunEvent {
  event: string;
  data: unknown;
}

export function serializeRunEvent(event: string, data: unknown): string {
  return JSON.stringify({ event, data } satisfies RunEvent);
}

/** 解析一条缓冲事件；坏数据返回 null（**绝不抛**：一条脏数据不该打断整次续传） */
export function parseRunEvent(raw: string): RunEvent | null {
  try {
    const parsed = JSON.parse(String(raw ?? '')) as Partial<RunEvent>;
    if (!parsed || typeof parsed.event !== 'string' || !parsed.event) return null;
    return { event: parsed.event, data: parsed.data };
  } catch {
    return null;
  }
}

/** SSE 帧；`data` 只允许单行（JSON 天然无换行） */
export function sseFrame(event: string, data: unknown): string {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

/**
 * 解析客户端报的「已看事件数」。
 * 缺省/脏数据/负数/非整数一律当 0（从头补）——宁可多补几条已知事件，
 * 也不要因为一个畸形参数把整次续传打回 400。
 */
export function parseResumeFrom(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 订阅端何时可以收流：已是终态，且客户端已看到全部已产出事件 */
export function streamCaughtUp(input: { status: unknown; from: number; eventCount: number }): boolean {
  return isRunTerminal(input.status) && input.from >= input.eventCount;
}
