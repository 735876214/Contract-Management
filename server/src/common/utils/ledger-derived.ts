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

/** 值是否"已填"（`0` 算已填；空串/空白算未填） */
export function isFilledNumber(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return Number.isFinite(Number(v));
}

const round2 = (n: number) => Number((Number(n) || 0).toFixed(2));

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
  /** 合同约定的付款比例（`ContractExt.currentPayRatio`，**原始值**，允许 `null`/`''`/`0`） */
  payRatio: unknown;
}

export interface LedgerDerivedFields {
  /** 应付款金额 = 审定结算额 × 付款比例；比例未填 → `null` */
  payableAmount: number | null;
  /** 应付未付 = 应付款金额 − 已付款；比例未填 → `null` */
  unpaidAmount: number | null;
  /** 100% 欠款 = 合同额 − 已付款；合同额未填 → `null`（**不是** `−已付款`） */
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

  const payableAmount = payRatioFilled ? round2(audited * Number(input.payRatio)) : null;

  return {
    payableAmount,
    // 比例未填时"应付未付"同样不可计算：若按 0 算会得到 −已付款（负数）
    unpaidAmount: payableAmount === null ? null : round2(payableAmount - cumPaid),
    debt100: amountFilled ? round2(amount - cumPaid) : null,
    settleRatio: amountFilled ? ratioPctOrNull(cumSettle, amount) : null,
    paidRatio: ratioPctOrNull(cumPaid, cumSettle),
    amountFilled,
  };
}
