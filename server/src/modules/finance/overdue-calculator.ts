/**
 * 逾期利息计算引擎（纯函数，无副作用，便于单测与前端复算对照）
 *
 * 业务规则（需求文档固化）：
 * 1. 逾期利息均为开累数据，逾期起始日期和应付款日期不变，变的只有付款时间；
 * 2. 计息金额：有付款时 = 付款金额；没付款（付款金额为 0）时 = 该笔应付款剩余未付金额；
 * 3. 付款分配顺序：按逾期起始日期时间顺序分配，并优先分配已逾期部分；
 * 4. 只要没付完钱，每笔金额最后一行付款金额为 0（对剩余金额计息一次）；
 * 5. 仅材料款计息，资金费用本身不计息（不利滚利）；
 * 6. 逾期利息（含税）= ROUND(计息金额 × 逾期天数 × 月利率 ÷ 30, 2)；
 * 7. 逾期天数使用 DAYS360（每月 30 天，每年 360 天）；
 * 8. 逾期起始日期 = 应付款日期 + 宽限天数 + 1。
 */

import { round } from '../../common/utils/money';

export { round };

/** DAYS360（US 方法）：每月按 30 天、每年按 360 天计算两日期间天数 */
export function days360(start: Date, end: Date): number {
  const y1 = start.getFullYear();
  const y2 = end.getFullYear();
  let m1 = start.getMonth();
  let m2 = end.getMonth();
  let d1 = start.getDate();
  let d2 = end.getDate();

  const lastDayOf = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
  const isLastFebDay = (d: Date) => d.getMonth() === 1 && d.getDate() === lastDayOf(d.getFullYear(), 1);

  if (isLastFebDay(start)) d1 = 30;
  if (d1 === 31) d1 = 30;
  // US 方法：当 d1 为 30（或2月最后一天）时，d2=31 记为 30
  if (d2 === 31 && d1 >= 30) d2 = 30;

  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

/** 日期加 n 天（返回新 Date） */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + n);
  return r;
}

/** 结算月份（YYYY-MM）+ 偏移月数 + 指定日 → 应付款日期 */
export function payableDateOf(settlementMonth: string, plusMonths: number, day: number): Date | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(settlementMonth || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1 + plusMonths;
  return new Date(year, month, day);
}

/** 付款模式默认配置 */
export interface PaymentModeDefaults {
  /** 每期付款：{ 比例, 结算月偏移, 应付款日 } */
  tranches: { ratio: number; plusMonths: number; day: number }[];
}

/** 两种标准付款模式（100% / 3382）的付款节点 */
export function modeTranches(mode: string | null | undefined): PaymentModeDefaults | null {
  if (mode === '100') {
    // 次月 25 日前支付 100%
    return { tranches: [{ ratio: 1, plusMonths: 1, day: 25 }] };
  }
  if (mode === '3382') {
    // 第 3 个月内支付 80%，第 6 个月支付剩余（累计 100%）
    return {
      tranches: [
        { ratio: 0.8, plusMonths: 3, day: 25 },
        { ratio: 0.2, plusMonths: 6, day: 25 },
      ],
    };
  }
  return null;
}

/** 台账行输入（来自前端，字段名与 OverdueInterest 模型一致） */
export interface OverdueRowInput {
  id?: string;
  settlementMonth: string;
  materialAmount?: number | null;
  paymentRatio?: number | null;
  payableDate?: string | Date | null;
  paymentDate?: string | Date | null;
  paymentAmount?: number | null;
  waived?: boolean;
  prevCumulative?: number | null; // 手动期初值（可选）
  remark?: string | null;
  isSettlementPeriod?: boolean;
  periodSeq?: number;
}

/** 引擎输出的派生字段 */
export interface OverdueDerived {
  payableAmount: number | null;
  overdueStartDate: Date | null;
  interestAmount: number | null; // 计息金额
  overdueDays: number | null;
  overdueInterest: number | null;
}

export interface EngineOptions {
  monthlyRate: number; // 月利率（合同覆盖值或系统默认）
  graceDays: number; // 宽限天数
  /** 计息截止日（用于未付完的剩余金额计息，默认今天） */
  asOfDate?: Date;
}

interface Entry {
  month: string;
  payableAmount: number;
  payableDate: Date;
  overdueStart: Date;
  remaining: number;
  rowId?: string; // 主行（materialAmount>0 的行）
}

/**
 * 重算整个合同的逾期利息台账：
 * 输入行（含用户输入）→ 付款分配 → 逐行派生字段 → 合计/结转统计。
 * 返回每行派生值（按输入顺序）与月度/汇总统计。
 */
export function recalculate(rows: OverdueRowInput[], opts: EngineOptions) {
  const rate = opts.monthlyRate || 0;
  const asOf = opts.asOfDate || new Date();

  // ---- 1. 构建应付款条目（materialAmount>0 的行为主行） ----
  const entries: Entry[] = [];
  for (const r of rows) {
    const material = Number(r.materialAmount) || 0;
    if (material <= 0) continue;
    const ratio = r.paymentRatio === null || r.paymentRatio === undefined ? 1 : Number(r.paymentRatio);
    const payable = round(material * ratio, 2) || 0;
    const pDate = r.payableDate ? new Date(r.payableDate) : null;
    if (!pDate || isNaN(pDate.getTime())) continue;
    const overdueStart = addDays(pDate, (opts.graceDays ?? 7) + 1);
    entries.push({ month: r.settlementMonth, payableAmount: payable, payableDate: pDate, overdueStart, remaining: payable, rowId: r.id });
  }
  // 按逾期起始日期顺序（应付款日期顺序）
  entries.sort((a, b) => a.overdueStart.getTime() - b.overdueStart.getTime() || a.month.localeCompare(b.month));

  // ---- 2. 付款事件（paymentAmount>0 且有付款日期），按付款时间排序 ----
  const paymentRows = rows
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => (Number(r.paymentAmount) || 0) > 0 && r.paymentDate);
  paymentRows.sort((a, b) => new Date(a.r.paymentDate as any).getTime() - new Date(b.r.paymentDate as any).getTime());

  // 每个付款行收集其分配到的片段
  const chunksByRowIdx = new Map<number, { amount: number; overdueStart: Date; paymentDate: Date }[]>();

  for (const { r, idx } of paymentRows) {
    let pay = Number(r.paymentAmount) || 0;
    const payDate = new Date(r.paymentDate as any);
    const chunks: { amount: number; overdueStart: Date; paymentDate: Date }[] = [];
    // 优先已逾期（overdueStart <= 付款日），再按逾期起始顺序补足
    const due = entries.filter((e) => e.remaining > 0 && e.overdueStart.getTime() <= payDate.getTime());
    const ahead = entries.filter((e) => e.remaining > 0 && e.overdueStart.getTime() > payDate.getTime());
    for (const e of [...due, ...ahead]) {
      if (pay <= 0) break;
      const alloc = Math.min(pay, e.remaining);
      e.remaining = round(e.remaining - alloc, 2) || 0;
      chunks.push({ amount: alloc, overdueStart: e.overdueStart, paymentDate: payDate });
      pay = round(pay - alloc, 2) || 0;
    }
    chunksByRowIdx.set(idx, chunks);
  }

  // ---- 3. 逐行派生字段 ----
  const derived = new Map<number, OverdueDerived>();
  // 无付款行（paymentAmount=0/空 且 materialAmount=0）：计息金额 = 剩余未付
  // 每个条目的剩余未付分配给该结算月份的“计息行”（paymentAmount=0 且非主行），按 periodSeq 顺序第一行承担
  const interestOnlyRows = rows
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => (Number(r.materialAmount) || 0) <= 0 && !(Number(r.paymentAmount) > 0));

  for (const e of entries) {
    if (e.remaining <= 0) continue;
    const target = interestOnlyRows
      .filter(({ r }) => r.settlementMonth === e.month)
      .sort((a, b) => (a.r.periodSeq || 0) - (b.r.periodSeq || 0))[0];
    if (target) {
      const days = Math.max(0, days360(e.overdueStart, asOf));
      const interest = round(e.remaining * days * rate / 30, 2) || 0;
      derived.set(target.idx, {
        payableAmount: e.payableAmount,
        overdueStartDate: e.overdueStart,
        interestAmount: e.remaining,
        overdueDays: days,
        overdueInterest: interest,
      });
      // 已承担，标记防止复用
      target.r.paymentAmount = -1;
    }
  }

  for (const { r, idx } of paymentRows) {
    const chunks = chunksByRowIdx.get(idx) || [];
    const payDate = new Date(r.paymentDate as any);
    const totalInterest = chunks.reduce((acc, c) => {
      const days = Math.max(0, days360(c.overdueStart, c.paymentDate));
      return acc + (c.amount * days * rate) / 30;
    }, 0);
    const first = chunks[0];
    derived.set(idx, {
      payableAmount: null,
      overdueStartDate: null,
      interestAmount: round(Number(r.paymentAmount), 2), // 有付款时计息金额 = 付款金额
      overdueDays: first ? Math.max(0, days360(first.overdueStart, payDate)) : null,
      overdueInterest: round(totalInterest, 2) || 0,
    });
  }

  // ---- 4. 主行（materialAmount>0）：应付款金额 / 逾期起始日期 ----
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const material = Number(r.materialAmount) || 0;
    if (material <= 0 || derived.has(idx)) continue;
    const entry = entries.find((e) => e.rowId === r.id);
    if (!entry) continue;
    derived.set(idx, {
      payableAmount: entry.payableAmount,
      overdueStartDate: entry.overdueStart,
      interestAmount: null,
      overdueDays: null,
      overdueInterest: 0,
    });
  }

  // ---- 5. 合计与结转统计 ----
  const interestOf = (idx: number) => (rows[idx].waived ? 0 : derived.get(idx)?.overdueInterest || 0);
  // 按结算月份排序计算开累
  const months = Array.from(new Set(rows.map((r) => r.settlementMonth))).sort();
  let cumulative = 0;
  const cumulativeByMonth = new Map<string, number>();
  for (const m of months) {
    const monthInterest = rows.reduce((acc, r, idx) => (r.settlementMonth === m ? acc + interestOf(idx) : acc), 0);
    cumulative = round(cumulative + monthInterest, 2) || 0;
    cumulativeByMonth.set(m, cumulative);
  }
  const totalMaterial = round(rows.reduce((acc, r) => acc + (Number(r.materialAmount) || 0), 0), 2) || 0;
  const totalPayment = round(rows.reduce((acc, r) => acc + (Number(r.paymentAmount) > 0 ? Number(r.paymentAmount) : 0), 0), 2) || 0;
  const totalInterest = cumulative;
  const perRowPrev = new Map<number, number | null>();
  rows.forEach((r, idx) => {
    // 上期开累 = 手动期初值优先，否则为上一结算月份的开累值
    if (r.prevCumulative !== null && r.prevCumulative !== undefined) perRowPrev.set(idx, Number(r.prevCumulative));
    else {
      const ms = months.filter((m) => m < r.settlementMonth);
      perRowPrev.set(idx, ms.length ? cumulativeByMonth.get(ms[ms.length - 1]) || 0 : 0);
    }
  });
  const currentMonth = months[months.length - 1];
  const prevCumulative = currentMonth ? perRowPrev.get(rows.findIndex((r) => r.settlementMonth === currentMonth)) || 0 : 0;

  return {
    derived,
    stats: {
      totalMaterial,
      totalPayment,
      totalInterest,
      currentCumulative: totalInterest,
      prevCumulative,
      currentSettlement: round(totalInterest - prevCumulative, 2) || 0,
      cumulativeByMonth: Object.fromEntries(cumulativeByMonth),
    },
  };
}
