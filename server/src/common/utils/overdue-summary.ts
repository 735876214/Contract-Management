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
 */

const round2 = (v: number): number => Math.round(v * 100) / 100;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
export function summarizeOverdue(
  rows: OverdueSummaryRow[],
  interestOfRow: (row: OverdueSummaryRow, index: number) => number,
): OverdueSummaryStats {
  const list = Array.isArray(rows) ? rows : [];

  const totalMaterial = round2(list.reduce((a, r) => a + (num(r?.materialAmount) ?? 0), 0)) || 0;
  const totalPayment =
    round2(list.reduce((a, r) => a + ((num(r?.paymentAmount) ?? 0) > 0 ? num(r.paymentAmount)! : 0), 0)) || 0;

  // 按结算月累计（月份的遍历顺序为字符串升序，即时间升序）
  const months = Array.from(new Set(list.map((r) => String(r?.settlementMonth ?? '')))).sort();
  const cumulativeByMonth: Record<string, number> = {};
  const interestByMonth = new Map<string, number>();
  list.forEach((r, i) => {
    const m = String(r?.settlementMonth ?? '');
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
  const firstRowOfCurrentMonth = list.find((r) => String(r?.settlementMonth ?? '') === currentMonth);
  const manual = num(firstRowOfCurrentMonth?.prevCumulative);
  const beforeMonths = months.filter((m) => m < currentMonth);
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
