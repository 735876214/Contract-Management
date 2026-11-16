import assert from 'node:assert/strict';
import { test } from 'node:test';
import { averageUnitPrice, deriveReceivingRow, weightedUnitPrice } from '../src/common/utils/labor-receiving.ts';

/**
 * 劳务队领用月度汇总 · 派生口径（附件需求 2026-10-17 第二批）。
 * 口径要点：未填 ≠ 0（三态契约）；显式 0 照常参与计算；节超正 = 超耗（扣款），负 = 节约（不扣）。
 */

test('净领 = 领用 − 退库；退库未填按 0', () => {
  assert.equal(deriveReceivingRow({ receivedQty: 10, returnQty: 3 }).netQty, 7);
  assert.equal(deriveReceivingRow({ receivedQty: 10 }).netQty, 10);
  assert.equal(deriveReceivingRow({ returnQty: 5 }).netQty, null); // 领用未填 → null
});

test('开累用量 = 上期末累计 + 净领；实耗 = 开累用量 − 盘点', () => {
  const d = deriveReceivingRow({ prevCum: 6, receivedQty: 4, returnQty: 1, stockTakeQty: 2 });
  assert.equal(d.netQty, 3);
  assert.equal(d.usedCum, 9);
  assert.equal(d.actualUse, 7);
});

test('扣款单价 = 单价 × 1.2', () => {
  assert.equal(deriveReceivingRow({ unitPrice: 100 }).deductPrice, 120);
  assert.equal(deriveReceivingRow({}).deductPrice, null);
});

test('设计量小计 = 开累 × (1 + 损耗率/100)', () => {
  assert.equal(deriveReceivingRow({ designQtyCum: 100, lossRate: 5 }).designSubtotal, 105);
  assert.equal(deriveReceivingRow({ designQtyCum: 100 }).designSubtotal, 100); // 损耗率未填按 0
});

test('节超 = 设计量小计 − 实耗（正 = 超耗）；扣款只在超耗时发生', () => {
  // 设计 105、实耗 110 → 超 5 → 扣款 5 × 120 = 600
  const over = deriveReceivingRow({
    prevCum: 0, receivedQty: 110, stockTakeQty: 0, designQtyCum: 100, lossRate: 5, unitPrice: 100,
  });
  assert.equal(over.saveOver, 5);
  assert.equal(over.deductAmount, 600);
  // 节约 → 扣款 0
  const save = deriveReceivingRow({
    prevCum: 0, receivedQty: 90, stockTakeQty: 0, designQtyCum: 100, lossRate: 5, unitPrice: 100,
  });
  assert.equal(save.saveOver, -15);
  assert.equal(save.deductAmount, 0);
  // 口径未知 → 扣款 null（不谎称 0）
  assert.equal(deriveReceivingRow({ unitPrice: 100 }).deductAmount, null);
});

test('实际损耗率 = (实耗 − 设计小计) ÷ 设计小计；分母 0/未知 → null', () => {
  const d = deriveReceivingRow({
    prevCum: 0, receivedQty: 110, stockTakeQty: 0, designQtyCum: 100, lossRate: 5,
  });
  assert.ok(Math.abs(d.actualLossRate - Math.round((5 / 105) * 1e4) / 1e4) < 1e-9); // 派生列保留 4 位
  assert.equal(deriveReceivingRow({ designQtyCum: 0, receivedQty: 10 }).actualLossRate, null);
});

test('三态契约：全空输入 → 派生列全 null', () => {
  const d = deriveReceivingRow({});
  for (const v of Object.values(d)) assert.equal(v, null, `期望 null，实际 ${v}`);
});

test('显式 0 是真实的 0：0 元合同照常算出扣款单价 0', () => {
  assert.equal(deriveReceivingRow({ unitPrice: 0 }).deductPrice, 0);
  assert.equal(deriveReceivingRow({ prevCum: 0, receivedQty: 0 }).usedCum, 0);
});

test('平均单价 = Σ税前总价 ÷ Σ数量；空聚合 / 0 数量 → null', () => {
  assert.equal(averageUnitPrice(1200, 10), 120);
  assert.equal(averageUnitPrice(0, 0), null);
  assert.equal(averageUnitPrice(null, 10), null);
  assert.equal(averageUnitPrice(1, 3), 0.3333);
});

test('加权单价 = Σ(数量×单价) ÷ Σ数量（月度盈亏分析汇总表跨队合并）', () => {
  assert.equal(
    weightedUnitPrice([
      { qty: 100, unitPrice: 10 },
      { qty: 300, unitPrice: 20 },
    ]),
    17.5,
  );
  // 单价未知的队：数量进分母、金额不虚构
  assert.equal(
    weightedUnitPrice([
      { qty: 100, unitPrice: 10 },
      { qty: 100, unitPrice: null },
    ]),
    5,
  );
  assert.equal(weightedUnitPrice([{ qty: 0, unitPrice: 10 }]), null);
  assert.equal(weightedUnitPrice([{ qty: 10, unitPrice: null }]), null);
  assert.equal(weightedUnitPrice([]), null);
});
