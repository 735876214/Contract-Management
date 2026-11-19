/**
 * 台账「派生金额」字段的单一实现（纯函数、**零依赖**）。
 *
 * ## 为什么单独抽出来
 *
 * 台账里有几列是**推出来的钱**（占合同比例、100% 欠款、应付款…）。这些列的分母可能**根本不存在**——
 * 合同允许不填金额（`Contract.amount` 是 `Decimal?`）。本仓对"没有金额"已经定过口径：
 * `common/utils/amount-guard.ts` 的那次修复（记录在 .claude/rules/backend-conventions.md 的「金额上限」与「台账」两节）明确
 * **「合同未填金额」≠「上限 0」**，而是"不可校验/无上限"。
 *
 * 台账此前没跟上这个口径，把未填金额当成 0，于是产出两类**错数**（开发库实测复现：
 * 52 份合同里 6 份 `amount IS NULL` 却各有 1 万审定结算）：
 *   1. `已结算金额占合同比例 = 0%` —— 谎称"一分未结"，实际有结算；而防超结闸门对同一批合同
 *      说的是"上限未知"（`contractChainAmount()` 返回 `null`）→ **同一件事两个相反结论**；
 *   2. `100%欠款 = 0 − 已付款` —— 未填金额却有付款时**直接给出负数**。
 *
 * 这里统一按 **"不可计算 → `null`"**，空值通道两端都已支持：前端 `money(null)` 显示 `-`，
 * 导出层遇 `null` 留白（`styled-excel.service.ts` 明写"空值显示为空白"）。
 *
 * ## 口径细节（与 amount-guard 对齐）
 *
 * - `null` / `undefined` / `''` → **不可计算**（`null`）
 * - 显式填了 `0` → **是真实的 0**（照常参与计算，与 guard 把 0 视为"已填"一致）——
 *   所以"0 元合同却有付款"仍会算出负的欠款，那正是**该被看见的数据异常**，不要抹平
 *
 * 保持纯函数（零第三方依赖）；相对 import 须带 `.ts` 后缀（2026-10-17 解除零依赖限制，见 .claude/rules/testing.md）。
 */

/** 金额舍入走全站唯一实现（字符串位移法，模拟 Excel ROUND，见 money.ts 文件头） */
import { round2 } from '../calc/money.ts';

/** 值是否"已填"（`0` 算已填；空串/空白算未填） */
export function isFilledNumber(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return Number.isFinite(Number(v));
}

/** 百分比（两位小数）；分母缺失或为 0 时返回 `null`（**不返回 0**，0 是个断言） */
export function ratioPctOrNull(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return round2(((Number(numerator) || 0) / denominator) * 100);
}

export interface LedgerDerivedInput {
  /** 合同额（**原始值**，允许 `null`/`''`/`0`） */
  amount: unknown;
  /** 开累结算额（= 结算台账「本月结算额」之和） */
  cumSettleAmount: number;
  /** 开累付款额 */
  cumPaidAmount: number;
  /** 审定结算额（= 结算单 `actualAmount` 之和） */
  auditedSettleAmount: number;
  /**
   * 总结算书（FinalSettlement）中的结算额 —— **100% 欠款** 的权威基数（业务口径 2026-11-19，用户确认）。
   * 该合同尚无总结算书时传 `null`/`undefined`，此时 100% 欠款退回用「开累结算额」。
   */
  finalSettleAmount?: number | null;
  /** 合同约定的付款比例（`ContractExt.currentPayRatio`，**原始值**，允许 `null`/`''`/`0`） */
  payRatio: unknown;
}

export interface LedgerDerivedFields {
  /** 应付款金额 = 审定结算额 × 付款比例；比例未填 → `null` */
  payableAmount: number | null;
  /** 应付未付 = 应付款金额 − 已付款；比例未填 → `null` */
  unpaidAmount: number | null;
  /**
   * 100% 欠款 = 审定结算额 − 已付款。
   * 审定结算额取 **总结算书（FinalSettlement）中的结算额**；该合同尚无总结算书时退回「开累结算额」。
   * （业务口径 2026-11-19，用户确认；与合同额无关，故合同未填金额时仍可计算）
   */
  debt100: number | null;
  /** 已结算金额占合同比例（%）；合同额未填 → `null`（**不是 0%**） */
  settleRatio: number | null;
  /** 已付款金额占结算比例（%）；无结算 → `null`（**不是 0%**） */
  paidRatio: number | null;
  /** 合同额是否已填（供调用方决定「合同额」列本身显示数值还是留空） */
  amountFilled: boolean;
}

/**
 * 由原始数据推出台账的派生金额列。**台账 `findAll()` 必须调用它**，不要就地再写算式
 * （就地写就会再次分叉出第二套口径——这正是本次修复的起因）。
 */
export function deriveLedgerAmounts(input: LedgerDerivedInput): LedgerDerivedFields {
  const amountFilled = isFilledNumber(input.amount);
  const amount = amountFilled ? round2(Number(input.amount)) : 0;
  const cumPaid = round2(input.cumPaidAmount);
  const cumSettle = round2(input.cumSettleAmount);
  const audited = round2(input.auditedSettleAmount);
  const payRatioFilled = isFilledNumber(input.payRatio);

  /**
   * 100% 欠款基数 = 审定结算额，其权威来源是**总结算书中的结算额**；无总结算书时退回「开累结算额」。
   * （业务口径 2026-11-19，用户确认。与合同额无关 → 不再依赖 amountFilled，合同未填金额也能算。）
   */
  const debtBase = isFilledNumber(input.finalSettleAmount) ? round2(Number(input.finalSettleAmount)) : cumSettle;

  const payableAmount = payRatioFilled ? round2(audited * Number(input.payRatio)) : null;

  return {
    payableAmount,
    // 比例未填时"应付未付"同样不可计算：若按 0 算会得到 −已付款（负数）
    unpaidAmount: payableAmount === null ? null : round2(payableAmount - cumPaid),
    debt100: round2(debtBase - cumPaid),
    settleRatio: amountFilled ? ratioPctOrNull(cumSettle, amount) : null,
    paidRatio: ratioPctOrNull(cumPaid, cumSettle),
    amountFilled,
  };
}

/**
 * 含税金额 → 税前 / 进项税额（**旧口径**：结算额 × 合同税率倒推）。
 *
 * 2026-11-18 起台账两列已改由发票派生（见 `sumInvoiceTax`），本函数仅保留作历史兜底/单测基线，
 * 台账 `findAll()` **不再调用**。
 *
 * 税率未填（NULL / 空串）→ 两列都返回 `null`（"未知"不兜成 0%，与其余派生列的三态一致）；
 * **显式填 `0` 是真实的 0%**，照常算出"税前 = 含税、税额 = 0"。
 */
export function deriveTaxSplit(
  amountWithTax: number,
  taxRatePct: unknown,
): { beforeTax: number | null; inputTax: number | null } {
  if (!isFilledNumber(taxRatePct)) return { beforeTax: null, inputTax: null };
  // 税率单轨百分数（13 = 13%）：含税 = 税前 × (1 + pct/100)
  const denominator = 1 + Number(taxRatePct) / 100;
  if (!Number.isFinite(denominator) || denominator === 0) return { beforeTax: null, inputTax: null };
  const total = round2(amountWithTax);
  const beforeTax = round2(total / denominator);
  return { beforeTax, inputTax: round2(total - beforeTax) };
}

/** 参与税额汇总的发票行（只取三列；原始值，允许 `null`/`''`） */
export interface InvoiceTaxSource {
  amountBeforeTax: unknown;
  amountWithTax: unknown;
  taxRatePct: unknown;
}

export interface InvoiceTaxSum {
  /** 开累发票税前金额；**无有效发票**时为 0（真值：没开票就是 0），有票但全算不出时 `null` */
  beforeTax: number | null;
  /** 开累发票进项税额；同上三态 */
  inputTax: number | null;
  /** 有票但税前或进项税算不出来的行数（导出时在标题提示"合计不含"） */
  incomplete: number;
}

/** 单张票的税前：票面优先，其次 含税 ÷ (1 + 税率) 反推（税率单轨百分数：13 = 13%） */
function invoiceBeforeTaxOf(r: InvoiceTaxSource): number | null {
  if (isFilledNumber(r.amountBeforeTax)) return round2(Number(r.amountBeforeTax));
  if (isFilledNumber(r.amountWithTax) && isFilledNumber(r.taxRatePct)) {
    const denominator = 1 + Number(r.taxRatePct) / 100;
    if (Number.isFinite(denominator) && denominator !== 0) return round2(Number(r.amountWithTax) / denominator);
  }
  return null;
}

/** 单张票的进项税：**含税 − 税前**（票面税率口径）；含税缺失时退回 税前 × 税率 */
function invoiceInputTaxOf(r: InvoiceTaxSource, beforeTax: number | null): number | null {
  if (beforeTax === null) return null;
  if (isFilledNumber(r.amountWithTax)) return round2(Number(r.amountWithTax) - beforeTax);
  if (isFilledNumber(r.taxRatePct)) return round2((beforeTax * Number(r.taxRatePct)) / 100);
  return null;
}

/**
 * 台账「开累发票税前金额」「开累发票进项税额」的**单一实现**（业务口径 2026-11-18：
 * 两列改由**发票模块自动派生**，不再用结算额 × 合同税率倒推）。
 *
 * - 逐张发票取「税前 / 进项税」后求和（先逐张舍入再加总，与票面税额一致）；
 * - `rows` 为空（该合同无有效发票）→ 两列都返回 **0**：没开票就是 0，是事实而非"未知"；
 * - 有票但税额算不出（税前与含税都为空，或税前为空且无税率反推）→ 该票不参与合计，
 *   且若全部票都算不出则对应列为 `null`（"未知"沿用全站三态，不兜成 0）。
 */
export function sumInvoiceTax(rows: InvoiceTaxSource[]): InvoiceTaxSum {
  let beforeSum = 0;
  let taxSum = 0;
  let beforeKnown = 0;
  let taxKnown = 0;
  let incomplete = 0;
  for (const r of rows) {
    const before = invoiceBeforeTaxOf(r);
    const tax = invoiceInputTaxOf(r, before);
    if (before !== null) {
      beforeSum += before;
      beforeKnown += 1;
    }
    if (tax !== null) {
      taxSum += tax;
      taxKnown += 1;
    }
    if (before === null || tax === null) incomplete += 1;
  }
  return {
    beforeTax: rows.length === 0 ? 0 : beforeKnown ? round2(beforeSum) : null,
    inputTax: rows.length === 0 ? 0 : taxKnown ? round2(taxSum) : null,
    incomplete,
  };
}

/**
 * 项目「合同额」合计：**每条合同链只计一次**（取主合同行上的链金额 `currentAmount`）。
 *
 * ⚠️ 补充协议行的 `amount` 是手填自由值（涨价/降价时常填"剩余数量的全价"），逐行相加会**重复计入**；
 * 补充协议的影响已经包含在主合同的 `currentAmount`（主合同 + Σ changeAmount）里。
 */
export interface ChainRowAmount {
  /** 本行合同 id */
  id: string;
  /** 链根（主合同）id：来自 `resolveChainAmounts().rootId` */
  rootId: string | null;
  /** 本行展示的链金额（同一链上的行值相同；主合同未填金额时为 null） */
  currentAmount: number | null;
}

/**
 * 按**链根**去重后的链金额表（key = 链根 id，value = 该链当前金额）。
 *
 * 判定只看 `rootId`（与 `contract-chain.ts` 的链定义同源），**不再依赖 `isSupplement` 字典值**——
 * 两份判据不一致时（有 `parentContractId` 但 `isSupplement≠'Y'`）会重复计入或漏计。
 */
export function chainRootAmounts(rows: ChainRowAmount[]): Map<string, number | null> {
  const byRoot = new Map<string, number | null>();
  for (const r of rows) {
    const key = r.rootId ?? r.id;
    if (!byRoot.has(key)) byRoot.set(key, r.currentAmount ?? null);
  }
  return byRoot;
}

/** 项目「合同额」合计：每条链只计一次（未填金额的链按 0 参与合计，调用方可另计"未填"条数） */
export function chainContractTotal(rows: ChainRowAmount[]): number {
  return round2([...chainRootAmounts(rows).values()].reduce((s, v) => s + (v ?? 0), 0));
}
