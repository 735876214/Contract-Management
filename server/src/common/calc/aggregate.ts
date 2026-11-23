/**
 * 月度/年度聚合原语（零运行时依赖，前后端共用）。
 *
 * 目的：把「同一件事散落多份」的聚合口径收敛为一组纯函数：
 * - 月份键统一经 `canonicalMonthKey` 归一（`2026-9`/`2026年9月` → `2026-09`），
 *   避免 `'2026-10' < '2026-9'` 的字典序错序；
 * - 分组求和统一按 `round` 收敛精度，禁止各处 `Number(x.toFixed(2))`；
 * - 「审定额 = actualAmount ?? amount」「送审额 = amount ?? actualAmount」
 *   这类来源优先级显式函数化，不再靠调用方手写 `??`。
 *
 * 业务特例通过 options 参数化，不在这里判断合同类型/模块来源。
 */
import { round } from './money.ts';
import { num } from './numeric.ts';
import { compareMonthKey, monthKey, parseMonthKey, periodMonthKey, toDate } from './time.ts';

/**
 * 任意来源 → 规范月份键 `YYYY-MM`。
 * - `Date`：按本地时区取月（与全站 `monthKey` 同口径）；
 * - `YYYY-MM`：严格校验；
 * - `2026-9` / `2026年9月` / `202609` / `2026-09-01`：按自由文本容错归一；
 * - 空值/非法值返回 null，由调用方决定丢弃还是进「未知月份」桶。
 */
export function canonicalMonthKey(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return monthKey(value);
  const s = String(value).trim();
  if (!s) return null;
  return parseMonthKey(s) ?? periodMonthKey(s);
}

/** 月份键排序；`unknownFirst` 用于兼容旧台账「未知月份排最前」的累积口径 */
export function sortMonthKeys(keys: readonly string[], unknownFirst = false): string[] {
  const unique = Array.from(new Set(keys.map((k) => String(k))));
  unique.sort(compareMonthKey);
  if (!unknownFirst) return unique;
  const unknown = unique.filter((k) => !k);
  return [...unknown, ...unique.filter((k) => k)];
}

export interface GroupSumByMonthOptions<T> {
  monthOf: (row: T) => unknown;
  amountOf: (row: T) => unknown;
  /** 默认丢弃无法识别月份的行；台账场景可置 true 归入 `''` */
  keepUnknown?: boolean;
  /** 未知月份在结果对象中的顺序：默认按 compareMonthKey（末尾） */
  unknownFirst?: boolean;
  digits?: number;
}

/** 按月份分组求和；每月结果即收敛精度，键按时间升序返回 */
export function groupSumByMonth<T>(rows: readonly T[], opts: GroupSumByMonthOptions<T>): Record<string, number> {
  const acc: Record<string, number> = {};
  const digits = opts.digits ?? 2;
  for (const row of rows) {
    const canonical = canonicalMonthKey(opts.monthOf(row));
    if (!canonical && !opts.keepUnknown) continue;
    const key = canonical ?? '';
    acc[key] = round((acc[key] ?? 0) + (num(opts.amountOf(row)) ?? 0), digits) ?? 0;
  }
  const ordered = sortMonthKeys(Object.keys(acc), opts.unknownFirst);
  return Object.fromEntries(ordered.map((k) => [k, acc[k]]));
}

/** 月度金额 → 逐月开累（每一步都收敛精度，避免浮点尾差滚入后续月份） */
export function cumulativeSumByMonth(
  monthly: Record<string, number>,
  opts: { unknownFirst?: boolean; digits?: number } = {},
): Record<string, number> {
  const digits = opts.digits ?? 2;
  const out: Record<string, number> = {};
  let cum = 0;
  for (const key of sortMonthKeys(Object.keys(monthly ?? {}), opts.unknownFirst)) {
    cum = round(cum + (num(monthly[key]) ?? 0), digits) ?? 0;
    out[key] = cum;
  }
  return out;
}

export interface GroupSumByYearOptions<T> {
  /** 年份从该字段取规范月份键；也接受 Date / 自由文本月份 */
  monthOf: (row: T) => unknown;
  amountOf: (row: T) => unknown;
  digits?: number;
}

/** 按年份分组求和（合同台账「每年结算额 / 每年付款额」口径）；无法识别月份的行丢弃 */
export function groupSumByYear<T>(rows: readonly T[], opts: GroupSumByYearOptions<T>): Record<string, number> {
  const acc: Record<string, number> = {};
  const digits = opts.digits ?? 2;
  for (const row of rows) {
    const key = canonicalMonthKey(opts.monthOf(row));
    if (!key) continue;
    const year = key.slice(0, 4);
    acc[year] = round((acc[year] ?? 0) + (num(opts.amountOf(row)) ?? 0), digits) ?? 0;
  }
  return Object.fromEntries(Object.keys(acc).sort().map((k) => [k, acc[k]]));
}

/** `count` 个月的本地月份序列（升序，`YYYY-MM`）；用于 Dashboard 近 12 月趋势 */
export function monthSequence(now: Date | string, count = 12): string[] {
  const base = toDate(now) ?? new Date();
  const n = Math.max(0, Math.floor(count));
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push(monthKey(d) as string);
  }
  return out;
}

/** 金额求和并收敛精度（Decimal 字符串直接吃） */
export function sumAmounts<T>(rows: readonly T[], amountOf: (row: T) => unknown, digits = 2): number {
  return round(rows.reduce((acc, row) => acc + (num(amountOf(row)) ?? 0), 0), digits) ?? 0;
}

export type SettlementAmountPriority = 'actual' | 'submitted';

/**
 * 结算单金额来源优先级：
 * - `actual`：审定 = `actualAmount ?? amount`（结算台账、开累结算、chain 口径）；
 * - `submitted`：送审 = `amount ?? actualAmount`（审减额两侧必须同口径）。
 *
 * 只认 `null/undefined` 为缺失，与 JS `??` 完全一致：空串/非法字符串视为「填了但无效」，
 * 交给 `num()` 变成 null 后按 0 处理，不偷偷回退到另一个字段。
 */
export function settlementAmountOf(row: any, priority: SettlementAmountPriority = 'actual'): number | null {
  if (!row || typeof row !== 'object') return null;
  const [first, second] = priority === 'submitted'
    ? [row.amount, row.actualAmount]
    : [row.actualAmount, row.amount];
  return num(first !== null && first !== undefined ? first : second);
}

/** 审定金额（简写入口） */
export const auditedAmountOf = (row: any): number | null => settlementAmountOf(row, 'actual');
/** 送审金额（简写入口） */
export const submittedAmountOf = (row: any): number | null => settlementAmountOf(row, 'submitted');

/** 兼容旧调用口径：只对金额求和，不做月份归一 */
export const sumRoundedAmounts = sumAmounts;
