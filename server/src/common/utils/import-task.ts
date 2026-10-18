/**
 * 异步导入任务（`ImportTask`）的**僵尸判定**与**幂等去重键**（零业务依赖，可单测）。
 *
 * 背景：`ImportTaskService` 采用「进程内 fire-and-forget」执行（无 worker 轮询）。此前
 * `execute()` 只把状态置 `RUNNING`，**没有任何心跳**；一旦进程崩溃/重启，该行会**永久停在
 * RUNNING**（`finishedAt` 永远为空），前端导入任务列表里就挂着一个永远"进行中"的任务。
 *
 * 本模块提供两个纯函数：
 * - `isImportTaskStale()`：判定某行是否已成为僵尸（供启动时与定时回收）；
 * - `importDedupeKey()`：同一份文件重复提交（双击 / 网络重试）时生成同一个键，
 *   用于「既有任务仍在处理中则不再新建任务」（注意：**只在 PENDING / RUNNING 期间去重**，
 *   已完成的任务不阻止再次导入同一份文件）。
 */
import { createHash } from 'node:crypto';

/** 僵尸阈值：超过该时长没有任何心跳即视为中断（默认 10 分钟） */
export const IMPORT_TASK_STALE_MS = 10 * 60 * 1000;

/** 回收任务的统一提示语 */
export const IMPORT_TASK_STALE_MESSAGE = '导入被中断（服务重启或执行超时），请重新导入';

/** 参与去重判定的任务状态 */
export const IMPORT_ACTIVE_STATUSES: readonly string[] = ['PENDING', 'RUNNING'];

interface TaskLike {
  status: string;
  /** 心跳时间（本次新增字段；老数据为空） */
  lockedAt?: Date | string | null;
  startedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = new Date(v as any).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * 是否已成僵尸：
 * - `RUNNING`：以 `lockedAt` 心跳为准；老数据没有心跳时依次回退 `startedAt` → `createdAt`
 *   （保证历史遗留的 RUNNING 行也能被回收）；
 * - `PENDING`：长时间未开始（无可用 worker / 进程在排队期崩溃）也算僵尸；
 * - `SUCCESS` / `FAILED` 终态一律返回 false（不重复回收）。
 */
export function isImportTaskStale(
  task: TaskLike,
  now: Date = new Date(),
  staleMs: number = IMPORT_TASK_STALE_MS,
): boolean {
  const status = String(task?.status ?? '');
  let ref: number | null = null;
  if (status === 'RUNNING') {
    ref = ms(task.lockedAt) ?? ms(task.startedAt) ?? ms(task.createdAt);
  } else if (status === 'PENDING') {
    ref = ms(task.createdAt);
  } else {
    return false;
  }
  if (ref === null) return false;
  return now.getTime() - ref > staleMs;
}

/**
 * 幂等去重键：`模块 + 文件名 + 行数 + 行内容摘要` 的 sha1。
 * 同一份文件（内容相同）重复提交会得到同一个键；只要前一个任务仍在 PENDING/RUNNING，
 * 就不再新建任务（返回既有 taskId）。
 *
 * 说明：对行内容做摘要（而非只看文件名+行数）是为了避免"同名同行数但内容不同"的误判；
 * 10k 行量级下 JSON 序列化 + sha1 约几毫秒，相对导入本身的数据库写入可忽略。
 */
export function importDedupeKey(parts: {
  module: string;
  /** 项目上下文（2026-10-18 审计修复）：不同项目导入同名同内容文件不得互相「去重」 */
  projectId?: string | null;
  fileName?: string | null;
  rows?: unknown[];
}): string {
  const h = createHash('sha1');
  h.update(String(parts?.module ?? ''));
  h.update('|');
  h.update(String(parts?.projectId ?? ''));
  h.update('|');
  h.update(String(parts?.fileName ?? ''));
  h.update('|');
  h.update(String(parts?.rows?.length ?? 0));
  h.update('|');
  try {
    h.update(JSON.stringify(parts?.rows ?? []));
  } catch {
    // 循环引用等极端情况：退化为「模块+文件名+行数」，仍能挡住绝大多数重复提交
  }
  return h.digest('hex');
}
