/**
 * AI · **有效发票口径（纯函数，AI 侧单一实现）**。
 *
 * 业务口径 2026-11-12：录红冲票时原票同步作废，作废（`CANCELLED`）与红冲（`RED`）
 * 都不属于「有效开票」。DB 查询用 `countedInvoiceWhere()`，内存过滤用
 * `isCountedInvoiceStatus()`——两者同源，本文件只是 AI 事实层对它的转口，
 * 避免 `scm-facts.ts` / `rules-payment.ts` / 新事实层各写一份谓词。
 *
 * 金额全程走 `moneyToCents()`（整数分），不经浮点。
 */

import { isCountedInvoiceStatus } from '../../../constants/statuses.ts';
import { centsToYuan, moneyToCents } from './money.ts';

export interface InvoiceRowLike {
  statusCode?: string | null;
  amountWithTax?: unknown;
}

/** 发票是否计入金额口径（`null` / 未填状态计入——历史导入数据） */
export function isCountedInvoice(row: InvoiceRowLike): boolean {
  return isCountedInvoiceStatus(row.statusCode);
}

/** 有效发票合计（元，两位小数；空值跳过，不兜 0 参与未知判断） */
export function sumCountedInvoices(rows: readonly InvoiceRowLike[]): number {
  let cents = 0n;
  for (const row of rows) {
    if (!isCountedInvoice(row)) continue;
    const c = moneyToCents(row.amountWithTax);
    if (c === null) continue;
    cents += c;
  }
  return Number(centsToYuan(cents));
}

/** 有效发票张数（与金额同一谓词） */
export function countCountedInvoices(rows: readonly InvoiceRowLike[]): number {
  return rows.reduce((n, row) => n + (isCountedInvoice(row) ? 1 : 0), 0);
}
