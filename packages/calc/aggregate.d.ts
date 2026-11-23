/**
 * 任意来源 → 规范月份键 `YYYY-MM`。
 * - `Date`：按本地时区取月（与全站 `monthKey` 同口径）；
 * - `YYYY-MM`：严格校验；
 * - `2026-9` / `2026年9月` / `202609` / `2026-09-01`：按自由文本容错归一；
 * - 空值/非法值返回 null，由调用方决定丢弃还是进「未知月份」桶。
 */
export declare function canonicalMonthKey(value: unknown): string | null;
/** 月份键排序；`unknownFirst` 用于兼容旧台账「未知月份排最前」的累积口径 */
export declare function sortMonthKeys(keys: readonly string[], unknownFirst?: boolean): string[];
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
export declare function groupSumByMonth<T>(rows: readonly T[], opts: GroupSumByMonthOptions<T>): Record<string, number>;
/** 月度金额 → 逐月开累（每一步都收敛精度，避免浮点尾差滚入后续月份） */
export declare function cumulativeSumByMonth(monthly: Record<string, number>, opts?: {
    unknownFirst?: boolean;
    digits?: number;
}): Record<string, number>;
export interface GroupSumByYearOptions<T> {
    /** 年份从该字段取规范月份键；也接受 Date / 自由文本月份 */
    monthOf: (row: T) => unknown;
    amountOf: (row: T) => unknown;
    digits?: number;
}
/** 按年份分组求和（合同台账「每年结算额 / 每年付款额」口径）；无法识别月份的行丢弃 */
export declare function groupSumByYear<T>(rows: readonly T[], opts: GroupSumByYearOptions<T>): Record<string, number>;
/** `count` 个月的本地月份序列（升序，`YYYY-MM`）；用于 Dashboard 近 12 月趋势 */
export declare function monthSequence(now: Date | string, count?: number): string[];
/** 金额求和并收敛精度（Decimal 字符串直接吃） */
export declare function sumAmounts<T>(rows: readonly T[], amountOf: (row: T) => unknown, digits?: number): number;
export type SettlementAmountPriority = 'actual' | 'submitted';
/**
 * 结算单金额来源优先级：
 * - `actual`：审定 = `actualAmount ?? amount`（结算台账、开累结算、chain 口径）；
 * - `submitted`：送审 = `amount ?? actualAmount`（审减额两侧必须同口径）。
 *
 * 只认 `null/undefined` 为缺失，与 JS `??` 完全一致：空串/非法字符串视为「填了但无效」，
 * 交给 `num()` 变成 null 后按 0 处理，不偷偷回退到另一个字段。
 */
export declare function settlementAmountOf(row: any, priority?: SettlementAmountPriority): number | null;
/** 审定金额（简写入口） */
export declare const auditedAmountOf: (row: any) => number | null;
/** 送审金额（简写入口） */
export declare const submittedAmountOf: (row: any) => number | null;
/** 兼容旧调用口径：只对金额求和，不做月份归一 */
export declare const sumRoundedAmounts: typeof sumAmounts;
