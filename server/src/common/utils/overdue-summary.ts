/**
 * 逾期利息台账的「汇总口径」——**单一实现**（零运行时依赖，可单测）。
 *
 * 背景：同一套汇总此前在两个地方各写了一遍：
 * - `modules/finance/overdue-calculator.ts` 的 `recalculate().stats`（录入/修改后重算时写入派生字段）
 * - `modules/finance/finance.service.ts` 的 `listOverdue().stats`（列表接口返回给页面）
 * 两者对 `totalMaterial / totalPayment / 开累 / 按月累计` 的算法一致，**但「上期开累」的取法不同**：
 * - 引擎：取「当前（最新）结算月**首行**」的 `prevCumulative`；该行为空时回退到上一结算月的开累；
 * - 列表：取「任意月份中**月份最大的那条**手工期初值」；没有手工值时回退上一结算月开累。
 * 于是当手工期初填在较早月份（或当前月非首行）时，两处会给出不同的 `prevCumulative / currentSettlement`。
 *
 * 本模块把「引擎口径」固化为唯一实现（更符合"上期开累 = 上一结算月末累计、可由本行手工期初覆盖"的语义），
 * 两处共同调用；差异行为由 `server/test/overdueSummary.spec.mts` 锁定。
 *
 * 注：**筛选范围**（列表接口支持按 `settlementMonth` 过滤）不属于本模块职责——
 * 调用方决定传入哪些行，本模块只负责"如何汇总这些行"。
 *
 * 舍入与月份排序已下沉到 `common/calc`：这里不再保留私有 `Math.round(v*100)/100`（浮点尾差）
 * 与原生字符串 `.sort()`（`2026-10` 会排在 `2026-9` 前）。
 */
import { round2 } from '../calc/money.ts';
import { num } from '../calc/numeric.ts';
import { canonicalMonthKey, compareMonthKey } from '../calc/index.ts';

/** 空月份仍像旧实现一样排最前；其余月份走统一 compareMonthKey（不能用 `'2026-10' < '2026-9'`） */
const compareMonthAsc = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return compareMonthKey(a, b);
};

export interface OverdueSummaryRow {
  settlementMonth?: string | null;
  materialAmount?: unknown;
  paymentAmount?: unknown;
  overdueInterest?: unknown;
  waived?: boolean | null;
  prevCumulative?: unknown;
}

export interface OverdueSummaryStats {
  /** 材料款合计 */
  totalMaterial: number;
  /** 实际付款合计（只累加 paymentAmount > 0 的行） */
  totalPayment: number;
  /** 开累逾期利息（**作废行不计入**） */
  currentCumulative: number;
  /** 各结算月的开累值（键为 YYYY-MM） */
  cumulativeByMonth: Record<string, number>;
  /** 最新结算月（无数据时为空串） */
  currentMonth: string;
  /** 上期开累（见文件头「上期开累」规则） */
  prevCumulative: number;
  /** 本期结算额 = 开累 − 上期开累 */
  currentSettlement: number;
}

/** 引擎 stats 与列表 stats 的**同一形状**：别名 totalInterest + 上限展示字段集中一处计算 */
export interface OverdueStats extends OverdueSummaryStats {
  /** 开累利息别名（引擎旧字段名，保留兼容） */
  totalInterest: number;
  /** 合同上限比例 */
  capRatio: number;
  /** 上限金额 = 材料款合计 × 上限比例 */
  capAmount: number;
  /** 上限使用率（%） */
  capUsage: number;
  /** 利息占材料款比例（%） */
  interestRatio: number;
}

/** 由统一汇总结果构造完整 stats：避免列表接口自己再算一遍 cap/占比 */
export function buildOverdueStats(summary: OverdueSummaryStats, capRatio = 0): OverdueStats {
  const ratio = Number.isFinite(Number(capRatio)) ? Number(capRatio) : 0;
  const capAmount = round2(summary.totalMaterial * ratio) || 0;
  return {
    ...summary,
    totalInterest: summary.currentCumulative,
    capRatio: ratio,
    capAmount,
    capUsage: capAmount ? round2((summary.currentCumulative / capAmount) * 100) || 0 : 0,
    interestRatio: summary.totalMaterial
      ? round2((summary.currentCumulative / summary.totalMaterial) * 100) || 0
      : 0,
  };
}

/** 单行计息额：作废（waived）按 0 计 */
export const interestOf = (row: OverdueSummaryRow, value?: unknown): number => {
  if (row?.waived) return 0;
  return round2(num(value ?? row?.overdueInterest) ?? 0) || 0;
};

/**
 * 汇总逾期利息台账。
 * @param rows       待汇总的行（顺序即调用方查询顺序：结算月 asc、periodSeq asc）
 * @param interestOf 取单行计息额的访问器——重算场景须传入「本次算出的值」，
 *                   列表场景传 `(r) => interestOf(r)`（读库中已持久化的值）
 */
// @metric: overdue-summary
export function summarizeOverdue(
  rows: OverdueSummaryRow[],
  interestOfRow: (row: OverdueSummaryRow, index: number) => number,
  /** `totalPayment`：实际付款合计的**外部覆盖值**——过期利息台账已改为
   *  「应付款项（主表）+ 付款流水（子表）」主子结构，付款额不再挂在主表行上，
   *  传行进来求和会恒得 0；调用方须把付款流水合计通过该字段传入。不传则沿用旧的按行累加。 */
  options?: { totalPayment?: number },
): OverdueSummaryStats {
  const list = Array.isArray(rows) ? rows : [];

  const totalMaterial = round2(list.reduce((a, r) => a + (num(r?.materialAmount) ?? 0), 0)) || 0;
  const overridePayment = num(options?.totalPayment);
  const totalPayment =
    overridePayment !== null
      ? round2(overridePayment) || 0
      : round2(list.reduce((a, r) => a + ((num(r?.paymentAmount) ?? 0) > 0 ? num(r.paymentAmount)! : 0), 0)) || 0;

  // 按结算月累计：月份先归一再排序（`2026-9` → `2026-09`，空月份仍归 '' 以兼容存量数据）
  const monthOf = (r: OverdueSummaryRow) => canonicalMonthKey(r?.settlementMonth) ?? '';
  const months = Array.from(new Set(list.map(monthOf))).sort(compareMonthAsc);
  const cumulativeByMonth: Record<string, number> = {};
  const interestByMonth = new Map<string, number>();
  list.forEach((r, i) => {
    const m = monthOf(r);
    interestByMonth.set(m, round2((interestByMonth.get(m) ?? 0) + interestOfRow(r, i)) || 0);
  });
  let cum = 0;
  for (const m of months) {
    cum = round2(cum + (interestByMonth.get(m) ?? 0)) || 0;
    cumulativeByMonth[m] = cum;
  }
  const currentMonth = months[months.length - 1] ?? '';
  const currentCumulative = currentMonth ? cumulativeByMonth[currentMonth] : 0;

  // 上期开累：当前结算月「首行」的手工期初优先；为空则取"当前月之前最近一个月"的开累（无则 0）
  const firstRowOfCurrentMonth = list.find((r) => monthOf(r) === currentMonth);
  const manual = num(firstRowOfCurrentMonth?.prevCumulative);
  const beforeMonths = months.filter((m) => compareMonthAsc(m, currentMonth) < 0);
  const prevCumulative =
    manual ?? (beforeMonths.length ? cumulativeByMonth[beforeMonths[beforeMonths.length - 1]] : 0);

  return {
    totalMaterial,
    totalPayment,
    currentCumulative,
    cumulativeByMonth,
    currentMonth,
    prevCumulative,
    currentSettlement: round2(currentCumulative - prevCumulative) || 0,
  };
}
