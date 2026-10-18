import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveContractFulfillment } from '../src/common/utils/contract-fulfillment.ts';

/**
 * 合同履约派生进度（业务口径 2026-10-18，零表）：
 * 汇总视角，不反写单据；分母未知/为 0 → null（前端显示 `-`），显式 0 照常参与。
 */
describe('合同履约派生进度', () => {
  const base = {
    currentAmount: 1000,
    orderedQty: 100,
    receivedQty: 40,
    settledAmount: 300,
    paidAmount: 200,
    invoicedAmount: 150,
  };

  it('常规比例与剩余量', () => {
    const r = deriveContractFulfillment(base);
    assert.equal(r.receivedRatio, 0.4);
    assert.equal(r.settledRatio, 0.3);
    assert.equal(r.paidVsSettledRatio, 0.6667);
    assert.equal(r.paidVsContractRatio, 0.2);
    assert.equal(r.invoiceRatio, 0.15);
    assert.equal(r.remainingToReceiveQty, 60);
    assert.equal(r.remainingToSettleAmount, 700);
    assert.equal(r.unpaidAmount, 100);
    assert.equal(r.hasReceiptNoSettlement, false);
    assert.equal(r.hasSettlementNoPayment, false);
  });

  it('合同额/清单量未知 → 相关比例与剩余量为 null（不是 0）', () => {
    const r = deriveContractFulfillment({
      ...base,
      currentAmount: null,
      orderedQty: null,
    });
    assert.equal(r.settledRatio, null);
    assert.equal(r.paidVsContractRatio, null);
    assert.equal(r.invoiceRatio, null);
    assert.equal(r.receivedRatio, null);
    assert.equal(r.remainingToReceiveQty, null);
    assert.equal(r.remainingToSettleAmount, null);
    // 不依赖合同额/清单量的指标照常给出
    assert.equal(r.paidVsSettledRatio, 0.6667);
    assert.equal(r.unpaidAmount, 100);
  });

  it('显式 0 是真实的 0：分母为 0 → 比例不可计算（null），金额差额照常算', () => {
    const r = deriveContractFulfillment({
      currentAmount: 0,
      orderedQty: 0,
      receivedQty: 0,
      settledAmount: 0,
      paidAmount: 0,
      invoicedAmount: 0,
    });
    assert.equal(r.receivedRatio, null);
    assert.equal(r.settledRatio, null);
    assert.equal(r.paidVsSettledRatio, null);
    assert.equal(r.remainingToReceiveQty, 0);
    assert.equal(r.remainingToSettleAmount, 0);
    assert.equal(r.unpaidAmount, 0);
    assert.equal(r.hasReceiptNoSettlement, false);
    assert.equal(r.hasSettlementNoPayment, false);
  });

  it('超收/超结/超付用负数暴露，不抹平', () => {
    const r = deriveContractFulfillment({
      ...base,
      receivedQty: 120,
      settledAmount: 1200,
      paidAmount: 1300,
    });
    assert.equal(r.remainingToReceiveQty, -20);
    assert.equal(r.remainingToSettleAmount, -200);
    assert.equal(r.unpaidAmount, -100);
  });

  it('有收货未结算 / 有结算未付款的标记', () => {
    const a = deriveContractFulfillment({ ...base, settledAmount: 0, paidAmount: 0 });
    assert.equal(a.hasReceiptNoSettlement, true);
    assert.equal(a.hasSettlementNoPayment, false);
    const b = deriveContractFulfillment({ ...base, paidAmount: 0 });
    assert.equal(b.hasReceiptNoSettlement, false);
    assert.equal(b.hasSettlementNoPayment, true);
  });
});
