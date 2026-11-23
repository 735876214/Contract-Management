/**
 * 金额 / 数量 / 比率的**前端展示**格式化 —— 全站唯一实现。
 *
 * 起因（2026-11-22 质量审计）：本节原是 20+ 个页面各写一份
 * `const money = (v) => …toLocaleString('zh-CN', …)`，选项组合有 7 种，于是
 * 同一笔金额在「台账」显示 `¥1,234.50`、在「成本盈亏」显示 `1,234.00`、在「收入分析」显示 `1,234`。
 * 更糟的是**无参数**的 `toLocaleString('zh-CN')` 会把 JS 浮点原样吐出：
 * 后端 `Number(Decimal)` 逐行求和后常见的 `1234.5600000000001` 会直接印在页面上。
 *
 * 三条口径（与台账「三态」契约一致）：
 * 1. **空值 ≠ 0**：null / undefined / '' / 非数字 一律显示占位符（默认 `-`），**不兜成 0**；
 * 2. 金额固定 2 位小数 + 千分位（会计口径）：`formatAmount` 不带币种、`formatMoney` 带 `¥`；
 * 3. 数量最多 N 位小数、**不补零**（1.5 吨显示 `1.5`，不是 `1.5000`）：`formatNumber`。
 *
 * ⚠️ 页面里禁止再直接写 `toLocaleString`；舍入本身仍走
 * `packages/calc/src/money.ts`（前后端同一实现，已由 `money.spec.ts` 锁住），
 * 本文件只负责**显示**。本文件零依赖，故能被 `server/test/*.spec.mts` 直接加载。
 */

/** 是否「未填」：null/undefined/空串/非有限数字。字符串按数字判断（后端 Decimal 常以字符串下发） */
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '' || !Number.isFinite(Number(v));
  if (typeof v === 'number') return !Number.isFinite(v);
  return true;
}

/**
 * 通用数字：千分位 + **最多** `digits` 位小数（不补零）。
 * `blank` 可覆盖占位符（HTML 表格里常用空串，避免表格里一片 `-`）。
 */
export function formatNumber(v: unknown, digits = 4, blank = '-'): string {
  if (isBlank(v)) return blank;
  return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: Math.max(0, Math.trunc(digits)) });
}

/** 金额（不带币种）：固定 `digits` 位小数 + 千分位，空值给占位符 */
export function formatAmount(v: unknown, digits = 2, blank = '-'): string {
  if (isBlank(v)) return blank;
  const d = Math.max(0, Math.trunc(digits));
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 金额（带 `¥`）：`formatAmount` 加币种符号；空值给占位符（**不会**显示成 `¥0`） */
export function formatMoney(v: unknown, digits = 2, blank = '-'): string {
  if (isBlank(v)) return blank;
  return `¥${formatAmount(v, digits)}`;
}

/**
 * 时间戳展示（本地口径，`2026-11-22 13:05:00`）。
 *
 * 只用于「操作时间/创建时间」这类**带时分秒**的列；业务日期（签订日、结算月）用
 * `@cms/calc/time` / `formatDay` 那一套，别用这里（会把日期显示成 `00:00:00`）。
 */
export function formatDateTime(v: unknown, blank = '-'): string {
  if (v === null || v === undefined || v === '') return blank;
  const d = v instanceof Date ? v : new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? blank : d.toLocaleString('zh-CN');
}

/** 比率（0~1）→ 百分数：0.65 → `65.00%`；空值给占位符。超过千分位的比例（如 12 = 1200%）也照实显示 */
export function formatPercent(ratio: unknown, digits = 2, blank = '-'): string {
  if (isBlank(ratio)) return blank;
  return `${formatAmount(Number(ratio) * 100, digits)}%`;
}
