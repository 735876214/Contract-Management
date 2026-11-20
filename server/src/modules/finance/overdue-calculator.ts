/**
 * 逾期利息计算引擎（纯函数，无副作用，便于单测与前端复算对照）
 *
 * 数据形状：**主子表**
 * - 主表 `OverduePayable`：一行 = 一个结算月份内的一期应付款项。
 *   拆期比例（如 3382 的 80%/20%）在**写入前**已由服务端把「本月材料款 × 比例」拆到该期的
 *   `materialAmount` 上，因此**该期材料款金额就是该期应付款金额**；`paymentRatio` 只作记录/展示，
 *   引擎不再乘一次比例（否则比例被重复计算），且「材料款合计」= Σ 各期材料款 = 整笔材料款。
 * - 子表 `OverduePayment`：付款流水，**不绑定某一期**，按"先已逾期、再未到期"的顺序跨期自动分配。
 *
 * 业务规则（需求文档固化）：
 * 1. 逾期利息均为开累数据，逾期起始日期和应付款日期不变，变的只有付款时间；
 * 2. 每期计息金额 = 已分配到该期的付款额 + 该期剩余未付金额；
 * 3. 付款分配顺序：按逾期起始日期时间顺序分配，并优先分配已逾期部分；
 * 4. 只要没付完钱，剩余部分按统计日（asOfDate）继续计息；
 * 5. 仅材料款计息，资金费用本身不计息（不利滚利）；
 * 6. 逾期利息（含税）= ROUND(计息金额 × 逾期天数 × 月利率 ÷ 30, 2)；
 * 7. 逾期天数使用 DAYS360（每月 30 天，每年 360 天）；
 * 8. 逾期起始日期 = 应付款日期 + 宽限天数 + 1。
 */

import { round } from '../../common/calc/money';
import { buildOverdueStats, summarizeOverdue, type OverdueStats } from '../../common/utils/overdue-summary';
import { modeTranchesOf } from '../../common/utils/pay-ratio';

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
  // 分期定义已收敛到零依赖的 `common/utils/pay-ratio.ts`（那里同时给出月度比例与"当前生效比例"的判定），
  // 这里只做一次委托：**别再在本文件里复制一份 tranches**，否则两处会漂移。
  const tranches = modeTranchesOf(mode);
  return tranches ? { tranches: tranches.map((t) => ({ ...t })) } : null;
}

/** 应付款项输入（来自前端/库，字段名与 OverduePayable 模型一致） */
export interface OverduePayableInput {
  id?: string;
  settlementMonth: string;
  periodSeq?: number;
  /** 该期的材料款金额（即该期应付款金额）。多期拆期时由服务端按比例预先拆分：
   *  录入的「本月材料款 100 万 × 80%」→ 本字段落库 800000，`paymentRatio` 仅记录 0.8。 */
  materialAmount?: number | null;
  /** 该期占本月材料款的比例（0.8 = 80%）。**只作记录/展示**，不参与计息金额计算。 */
  paymentRatio?: number | null;
  payableDate?: string | Date | null;
  waived?: boolean;
  prevCumulative?: number | null; // 手动期初值（可选）
  remark?: string | null;
  isSettlementPeriod?: boolean;
}

/** 付款流水输入（字段名与 OverduePayment 模型一致） */
export interface OverduePaymentInput {
  id?: string;
  paymentDate: string | Date;
  paymentAmount: number;
  remark?: string | null;
}

/** 某期分到的付款片段（供展开行展示"这笔钱抵了哪几期 / 每段算了几天利息"） */
export interface PayableChunk {
  paymentId: string | null;
  paymentDate: Date;
  amount: number;
  overdueDays: number;
  interest: number;
}

/** 引擎输出的派生字段（主表上会回写同名同形列） */
export interface PayableDerived {
  payableAmount: number | null;
  overdueStartDate: Date | null;
  interestAmount: number | null; // 计息金额 = 已分配到本期的付款额 + 未付余额
  overdueDays: number | null;
  overdueInterest: number | null;
  /** 已分配到本期的付款合计（仅计算用，不落库） */
  paidAmount: number;
  /** 未付余额（仅计算用，不落库） */
  remaining: number;
  /** 本期分配到的付款片段（仅计算用，不落库） */
  chunks: PayableChunk[];
}

export interface EngineOptions {
  monthlyRate: number; // 月利率（合同覆盖值或系统默认）
  graceDays: number; // 宽限天数
  /** 计息截止日（用于未付完的剩余金额计息）——**必填**：规则层不读系统时钟，由 service 层显式注入 */
  asOfDate: Date;
  /** 合同逾期利息上限比例（仅用于 stats 展示，与列表接口同口径） */
  interestCapRatio?: number;
}

interface Entry {
  /** 在入参数组中的下标——**不能改用 rowId 反查**：本引擎按文档也可用于「前端复算/单测」，
   *  那种场景下入参往往没有 id，用 rowId 匹配会退化成「总取第一个条目」。 */
  srcIdx: number;
  month: string;
  periodSeq: number;
  payableAmount: number;
  payableDate: Date;
  overdueStart: Date;
  remaining: number;
  paid: number;
  chunks: { paymentId: string | null; paymentDate: Date; amount: number }[];
}

/**
 * 重算整个合同的逾期利息台账：
 * 应付款项（含用户输入）+ 付款流水 → 付款跨期分配 → 逐期派生字段 → 合计/结转统计。
 * 返回每期派生值（按输入顺序）与月度/汇总统计。
 */
export function recalculatePayables(
  payables: OverduePayableInput[],
  payments: OverduePaymentInput[],
  opts: EngineOptions,
) {
  const rate = opts.monthlyRate || 0;
  // 规则层不读系统时钟：漏传/非法基准日直接抛错，绝不默默用「今天」把同一批数据算出随日期漂移的结果。
  if (!(opts.asOfDate instanceof Date) || isNaN(opts.asOfDate.getTime())) {
    throw new TypeError('recalculatePayables 必须显式传入有效的 asOfDate');
  }
  const asOf = opts.asOfDate;
  const list = Array.isArray(payables) ? payables : [];

  // ---- 1. 构建应付款条目（materialAmount>0 且应付款日期合法的期） ----
  const entries: Entry[] = [];
  list.forEach((p, idx) => {
    const material = Number(p.materialAmount) || 0;
    if (material <= 0) return;
    // 该期材料款金额就是该期应付款金额：拆期比例在**写入前**已由服务端拆到 materialAmount 上
    // （80% 那期落库 800000），引擎不再乘一次 paymentRatio，否则比例会被重复计算。
    // 这样「材料款合计」= Σ 各期材料款 = 该结算月的整笔材料款，卡片口径与旧台账一致。
    const payableAmount = round(material, 2) || 0;
    const pDate = p.payableDate ? new Date(p.payableDate) : null;
    if (!pDate || isNaN(pDate.getTime())) return;
    entries.push({
      srcIdx: idx,
      month: p.settlementMonth,
      periodSeq: Number(p.periodSeq) || 1,
      payableAmount,
      payableDate: pDate,
      overdueStart: addDays(pDate, (opts.graceDays ?? 7) + 1),
      remaining: payableAmount,
      paid: 0,
      chunks: [],
    });
  });
  // 按逾期起始日期顺序（应付款日期顺序）；同日按结算月、期次兜底，保证分配结果可复现
  entries.sort(
    (a, b) =>
      a.overdueStart.getTime() - b.overdueStart.getTime() ||
      a.month.localeCompare(b.month) ||
      a.periodSeq - b.periodSeq,
  );

  // ---- 2. 付款事件（paymentAmount>0 且有付款日期），按付款时间排序 ----
  const payList = (Array.isArray(payments) ? payments : [])
    .filter((p) => (Number(p.paymentAmount) || 0) > 0 && p.paymentDate)
    .map((p, idx) => ({ p, idx, time: new Date(p.paymentDate as any).getTime() }))
    .filter((x) => !isNaN(x.time))
    .sort((a, b) => a.time - b.time || a.idx - b.idx);

  for (const { p } of payList) {
    let pay = Number(p.paymentAmount) || 0;
    const payDate = new Date(p.paymentDate as any);
    // 优先已逾期（overdueStart <= 付款日），再按逾期起始顺序补足
    const due = entries.filter((e) => e.remaining > 0 && e.overdueStart.getTime() <= payDate.getTime());
    const ahead = entries.filter((e) => e.remaining > 0 && e.overdueStart.getTime() > payDate.getTime());
    for (const e of [...due, ...ahead]) {
      if (pay <= 0) break;
      const alloc = round(Math.min(pay, e.remaining), 2) || 0;
      if (alloc <= 0) continue;
      e.remaining = round(e.remaining - alloc, 2) || 0;
      e.paid = round(e.paid + alloc, 2) || 0;
      e.chunks.push({ paymentId: p.id ?? null, paymentDate: payDate, amount: alloc });
      pay = round(pay - alloc, 2) || 0;
    }
  }

  // ---- 3. 逐期派生字段 ----
  const derived = new Map<number, PayableDerived>();
  for (const e of entries) {
    const chunks: PayableChunk[] = e.chunks.map((c) => {
      const days = Math.max(0, days360(e.overdueStart, c.paymentDate));
      return {
        paymentId: c.paymentId,
        paymentDate: c.paymentDate,
        amount: c.amount,
        overdueDays: days,
        interest: round((c.amount * days * rate) / 30, 2) || 0,
      };
    });
    const paidInterest = chunks.reduce((a, c) => a + (c.interest || 0), 0);
    const openDays = e.remaining > 0 ? Math.max(0, days360(e.overdueStart, asOf)) : 0;
    const openInterest = e.remaining > 0 ? round((e.remaining * openDays * rate) / 30, 2) || 0 : 0;
    const maxChunkDays = chunks.reduce((a, c) => Math.max(a, c.overdueDays), 0);
    const overdueDays = Math.max(maxChunkDays, openDays);
    derived.set(e.srcIdx, {
      payableAmount: e.payableAmount,
      overdueStartDate: e.overdueStart,
      // 计息金额 = 已付部分 + 未付余额 = 应付款金额（未付完时恰好等于应付款金额）
      interestAmount: round(e.paid + e.remaining, 2) || 0,
      overdueDays,
      overdueInterest: round(paidInterest + openInterest, 2) || 0,
      paidAmount: e.paid,
      remaining: e.remaining,
      chunks,
    });
  }

  // ---- 4. 合计与结转统计 ----
  // 汇总口径（含「上期开累」规则）统一在 common/utils/overdue-summary.ts，与列表接口共用一份实现
  const summary = summarizeOverdue(
    list,
    (row, idx) => (row.waived ? 0 : derived.get(idx)?.overdueInterest || 0),
    // 应付款项主子表里付款额不在主表上：实际付款合计必须由付款流水给出，否则恒为 0
    { totalPayment: round(payList.reduce((a, { p }) => a + (Number(p.paymentAmount) || 0), 0), 2) || 0 },
  );

  return {
    derived,
    // 与列表接口返回完全同形的 stats（含 cap 字段），避免两处各自拼装导致口径漂移
    stats: buildOverdueStats(summary, opts.interestCapRatio),
  };
}

/** 无派生值时的空值——与写库 `d?.xxx ?? null` 口径严格一致 */
export const EMPTY_PAYABLE_DERIVED: PayableDerived = {
  payableAmount: null,
  overdueStartDate: null,
  interestAmount: null,
  overdueDays: null,
  overdueInterest: null,
  paidAmount: 0,
  remaining: 0,
  chunks: [],
};

/**
 * 读时重算（不写库）：把引擎按 asOfDate 算出的派生列覆盖到每一期，返回可直接展示的行。
 *
 * 为什么需要：逾期派生列（overdueDays / overdueInterest 等）此前只在增删改时重算并持久化，
 * 之后每过一天，未付完的剩余金额本应继续计息，库内值却停在上次写入那天 → 台账陈旧。
 * 读接口改为「查询时按当前 asOfDate 走**同一个 recalculatePayables 引擎**重算一遍再展示」，
 * 无需引入定时刷新任务，也不产生第二套计算口径；库内持久化列退化为写入时的快照/缓存。
 *
 * `derived` 的 key 是入参下标（不依赖 id，故前端复算/无 id 场景同样可用）；
 * 引擎判定该期当前不应有派生值时用 EMPTY_PAYABLE_DERIVED 置空，与写库口径一致。
 */
export function recomputePayableRows(
  payables: OverduePayableInput[],
  payments: OverduePaymentInput[],
  opts: EngineOptions,
): { rows: Array<OverduePayableInput & PayableDerived>; stats: OverdueStats } {
  const { derived, stats } = recalculatePayables(payables, payments, opts);
  return {
    rows: payables.map((p, idx) => ({ ...p, ...(derived.get(idx) ?? EMPTY_PAYABLE_DERIVED) })),
    stats,
  };
}
