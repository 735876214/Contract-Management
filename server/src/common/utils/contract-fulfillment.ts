/**
 * 合同履约派生进度（业务口径 2026-10-18：零表派生）。
 *
 * 履约是「总日报 / 收领单 → 结算 → 付款 → 发票」的**汇总视角**，不反写任何单据；
 * 与台账同哲学（`ledger-derived.ts`）：**分母未知 ≠ 0**——
 * 合同额/清单量未填时相关比例返回 `null`（前端显示 `-`），显式 0 照常参与计算。
 *
 * 纯函数（零依赖，仅用 `money.ts`），供 `contract-fulfillment.service.ts` 调用，
 * 并由 `server/test/contractFulfillment.spec.mts` 直接加载锁定。
 */

import { round2, round4 } from './money.ts';

export interface FulfillmentInput {
  /** 合同当前金额（合同链：主合同 + Σ 补充协议 changeAmount）；未填 → null */
  currentAmount: number | null;
  /** 链上清单量合计；无清单行或数量未填 → null */
  orderedQty: number | null;
  /** 已收数量（总日报 settleQty 合计，按 require_confirmed 过滤） */
  receivedQty: number;
  /** 已结算金额（实际结算额，排除草稿） */
  settledAmount: number;
  /** 已付款金额（排除失败/退款） */
  paidAmount: number;
  /** 已开票金额 */
  invoicedAmount: number;
}

export interface FulfillmentResult {
  /** 已收 / 订购（清单量） */
  receivedRatio: number | null;
  /** 已结 / 合同当前金额 */
  settledRatio: number | null;
  /** 已付 / 已结 */
  paidVsSettledRatio: number | null;
  /** 已付 / 合同当前金额 */
  paidVsContractRatio: number | null;
  /** 已开票 / 合同当前金额 */
  invoiceRatio: number | null;
  /** 未收数量（订购 − 已收；可为负，暴露超收） */
  remainingToReceiveQty: number | null;
  /** 待结金额（合同当前金额 − 已结；可为负，暴露超结） */
  remainingToSettleAmount: number | null;
  /** 未付金额（已结 − 已付；可为负，暴露超付） */
  unpaidAmount: number;
  /** 有收货但尚未结算 */
  hasReceiptNoSettlement: boolean;
  /** 有结算但尚未付款 */
  hasSettlementNoPayment: boolean;
}

/** 比例：分母未知或 ≤ 0 → `null`（不可计算）；显式 0 也不做除法 */
function ratio(numerator: number, denominator: number | null): number | null {
  if (denominator == null || denominator <= 0) return null;
  return round4(numerator / denominator);
}

export function deriveContractFulfillment(input: FulfillmentInput): FulfillmentResult {
  const currentAmount = input.currentAmount;
  const orderedQty = input.orderedQty;
  const receivedQty = input.receivedQty;
  const settled = input.settledAmount;
  const paid = input.paidAmount;

  return {
    receivedRatio: ratio(receivedQty, orderedQty),
    settledRatio: ratio(settled, currentAmount),
    paidVsSettledRatio: ratio(paid, settled),
    paidVsContractRatio: ratio(paid, currentAmount),
    invoiceRatio: ratio(input.invoicedAmount, currentAmount),
    remainingToReceiveQty:
      orderedQty == null ? null : round4(orderedQty - receivedQty),
    remainingToSettleAmount:
      currentAmount == null ? null : round2(currentAmount - settled),
    unpaidAmount: round2(settled - paid),
    hasReceiptNoSettlement: receivedQty > 0 && settled <= 0,
    hasSettlementNoPayment: settled > 0 && paid <= 0,
  };
}
