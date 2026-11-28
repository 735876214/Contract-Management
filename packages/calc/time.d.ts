export declare function toDate(v: unknown): Date | null;
/**
 * 本地口径 `YYYY-MM-DD`；非法日期返回 null。
 *
 * 纯日期串（`2026-01-05`）**不经过 Date**：`new Date("2026-01-05")` 按 **UTC** 解析，
 * 在 UTC 负偏移的时区里（浏览器可能不在 +08:00）回退成前一天，而这串日期是要印在正式单据上的。
 * 这里只校验「是不是真日子」（`2026-02-30` → null），不做任何时区换算。
 */
export declare function formatDay(v: unknown): string | null;
/** 本地口径 `YYYY-MM-DD`；兼容 helpers.localDayKey 的旧签名（非法日期返回空串） */
export declare function localDayKey(now?: Date | string | null): string;
/** 区间左边界：当天本地零点（含）。非法/空值返回 null，调用方应跳过该条件而不是写 `null` 进 where */
export declare function startOfDay(v: unknown): Date | null;
/**
 * 区间右边界：当天本地最后一毫秒（含）。
 *
 * 列表筛选统一用它（`lte: endOfDay(endDate)`）：直接 `lte: new Date('YYYY-MM-DD')` 会把当天
 * 00:00 之后的记录全部漏掉，而各模块曾出现「有的补 23:59:59、有的不补」三种写法。
 * 更推荐 `lt: nextDayStart(endDate)`（不依赖毫秒精度），两者都在本文件实现。
 */
export declare function endOfDay(v: unknown): Date | null;
/** 次日本地零点（开区间上界）：配合 `lt` 使用，跨月/跨年由 Date 自动进位 */
export declare function nextDayStart(v: unknown): Date | null;
/** 日期 → 月份键 `YYYY-MM`（本地时区） */
export declare function monthKey(d: unknown): string | null;
/** 严格校验并归一化月份键 `YYYY-MM`；`2026-9` / `2026/09` 一律拒绝 */
export declare function parseMonthKey(value: unknown): string | null;
/** 自由文本「结算账期」→ 月份键；认不出返回 null（调用方回落到按开票日期归集） */
export declare function periodMonthKey(text: string | null | undefined): string | null;
/** 月份键排序：零补齐后可直接字典序比较；空值排末尾 */
export declare function compareMonthKey(a: unknown, b: unknown): number;
export declare function yearOf(v: unknown): number | null;
/** 兼容 helpers.fmtDate 的旧名称 */
export declare const fmtDate: typeof formatDay;
