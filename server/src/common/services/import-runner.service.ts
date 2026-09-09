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
  /** 进度回调：每校验完一行触发（异步导入任务用于刷新进度） */
  onProgress?: (processed: number, total: number) => void | Promise<void>;
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

    // 任一行校验失败：不写入任何数据
    if (errors.length) return { total: rows.length, created: 0, updated: 0, errors };
    if (!plans.length) return { total: rows.length, created: 0, updated: 0, errors: [] };

    const res = await this.prisma.$transaction(async (tx) => opts.write(plans, tx as TxClient));
    return { total: rows.length, created: res?.created || 0, updated: res?.updated || 0, errors: [] };
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
