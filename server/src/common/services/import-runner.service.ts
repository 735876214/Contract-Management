import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertImportRows } from '../utils/helpers';

/** 行级错误：携带字段信息，便于生成详细错误报告 */
export class RowError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'RowError';
    this.field = field;
  }
}

export interface ImportRowError {
  row: number;
  field?: string;
  message: string;
}

export interface ImportOutcome {
  /** 解析出的总行数（用于导入日志统计） */
  total: number;
  created: number;
  updated: number;
  errors: ImportRowError[];
  /** validateOnly 模式：校验是否全部通过 */
  valid?: boolean;
}

export type TxClient = Prisma.TransactionClient;

export interface RunOptions<T> {
  /** 校验并生成「写入计划」，此阶段禁止写库；返回 null 表示跳过该行 */
  plan: (row: any, ctx: { index: number; rowNo: number }) => Promise<T | null>;
  /** 在数据库事务中执行全部写入计划 */
  write: (plans: T[], tx: TxClient) => Promise<{ created?: number; updated?: number }>;
  /** 数据起始行号（用于错误报告行号对齐 Excel） */
  startRowNo?: number;
  maxRows?: number;
  /** 仅校验不写库：跑完 plan 阶段后直接返回校验结果（跳过异步任务与事务写入） */
  validateOnly?: boolean;
  /** 进度回调：每校验完一行触发（异步导入任务用于刷新进度） */
  onProgress?: (processed: number, total: number) => void | Promise<void>;
  /**
   * **事务提交后**的收尾动作（可选）：只在「确有写入」时调用，且**失败不影响导入结果**。
   *
   * 用途：某些写入要连带刷新**别的**聚合表，而那个刷新必须读得到刚提交的数据
   * （事务内读不到未提交行）。发票导入后刷新结算台账的「本月开票额」就是一例。
   * ⚠️ 放在这里而不是 `write` 里：`write` 在事务内，刷新会读到旧数据甚至死锁。
   * ⚠️ 错误只记日志：数据已经提交，把导入标成失败（并让调用方以为没写）比"少刷新一次台账"糟得多——
   *    台账可以人工点「刷新台账」补，导入结果不能重来。
   */
  afterCommit?: (outcome: ImportOutcome) => Promise<void>;
}

/**
 * 导入执行器（需求 2.1）：
 * - 两阶段：先全量校验生成写入计划，再于事务中一次性写入
 * - 全成功或全失败：任一行校验失败即返回错误报告，不写入任何数据；事务内异常整体回滚
 * - 错误报告结构化：行号 + 错误字段 + 错误描述
 */
@Injectable()
export class ImportRunnerService {
  constructor(private prisma: PrismaClient) {}

  async run<T>(rows: any[], opts: RunOptions<T>): Promise<ImportOutcome> {
    const startRowNo = opts.startRowNo ?? 3;
    if (!Array.isArray(rows)) throw new BadRequestException('导入内容为空');
    assertImportRows(rows, opts.maxRows);

    const plans: T[] = [];
    const errors: ImportRowError[] = [];
    for (const [index, row] of rows.entries()) {
      const rowNo = startRowNo + index;
      try {
        const plan = await opts.plan(row, { index, rowNo });
        if (plan !== null && plan !== undefined) plans.push(plan);
      } catch (e: any) {
        errors.push({ row: rowNo, field: e?.field, message: e?.message || String(e) });
      }
      if (opts.onProgress) await opts.onProgress(index + 1, rows.length);
    }

    // 仅校验模式：plan 阶段跑完即返回，不进入事务写入
    if (opts.validateOnly) {
      return { total: rows.length, created: 0, updated: 0, errors, valid: !errors.length };
    }

    // 任一行校验失败：不写入任何数据
    if (errors.length) return { total: rows.length, created: 0, updated: 0, errors };
    if (!plans.length) return { total: rows.length, created: 0, updated: 0, errors: [] };

    const res = await this.prisma.$transaction(async (tx) => opts.write(plans, tx as TxClient));
    const outcome: ImportOutcome = { total: rows.length, created: res?.created || 0, updated: res?.updated || 0, errors: [] };
    if (opts.afterCommit) {
      try {
        await opts.afterCommit(outcome);
      } catch (e: any) {
        // 数据已提交：收尾动作失败只记日志（见 RunOptions.afterCommit 的说明），不改变导入结果
        // eslint-disable-next-line no-console
        console.warn('[import] 提交后的收尾动作失败（数据已写入，不影响导入结果）:', e?.message || e);
      }
    }
    return outcome;
  }

  /** 简易内存去重器：批内重复检测 */
  batchDup() {
    const seen = new Set<string>();
    return (key: string, message: string, field?: string) => {
      if (seen.has(key)) throw new RowError(message, field);
      seen.add(key);
    };
  }
}
