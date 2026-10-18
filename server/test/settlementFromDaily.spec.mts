import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettlementItemsFromDailyRows } from '../src/common/utils/settlement-from-daily.ts';

/**
 * 总日报 → 结算明细带出（业务口径 2026-10-18）：
 * 结算单必须在总日报之后生成，明细从总日报按物资聚合带出、生成后允许人工修改。
 * 这里锁的是纯聚合口径：同物资加权平均、金额按同一公式重算、缺物资主数据的行不静默丢。
 */
describe('结算明细 · 从总日报带出', () => {
  it('同物资多行按数量加权平均，金额与明细合价同口径', () => {
    const res = buildSettlementItemsFromDailyRows([
      { materialBaseId: 'm1', settleQty: 10, priceBeforeTax: 100, taxRate: 13, amountAfterTax: 1130, receiptNo: 'SO1' },
      { materialBaseId: 'm1', settleQty: 5, priceBeforeTax: 200, taxRate: 13, amountAfterTax: 1130, receiptNo: 'SO2' },
    ]);
    assert.equal(res.items.length, 1);
    const it = res.items[0];
    assert.equal(it.qty, 15);
    // 加权税前 = (100×10 + 200×5) / 15 = 133.3333
    assert.equal(it.priceBeforeTax, 133.3333);
    assert.equal(it.taxRatePct, 13);
    // 含税 = 133.3333 × 1.13 = 150.6666（4 位）；合价 = 150.6666 × 15 = 2260（2 位）
    assert.equal(it.priceWithTax, 150.6666);
    assert.equal(it.totalWithTax, 2260);
    assert.equal(res.amount, 2260);
    assert.match(it.remark, /总日报/);
    assert.match(it.remark, /SO1|SO2/);
  });

  it('金额缺失时用单价 × 数量补算；含税单价独有时按 0 税率反推税前', () => {
    const res = buildSettlementItemsFromDailyRows([
      { materialBaseId: 'm2', settleQty: 2, priceBeforeTax: 50, taxRate: 13 },
      { materialBaseId: 'm3', settleQty: 1, priceAfterTax: 90 },
    ]);
    assert.equal(res.items.length, 2);
    const m2 = res.items.find((i) => i.materialBaseId === 'm2')!;
    assert.equal(m2.priceWithTax, 56.5);
    assert.equal(m2.totalWithTax, 113);
    const m3 = res.items.find((i) => i.materialBaseId === 'm3')!;
    assert.equal(m3.priceBeforeTax, 90);
    assert.equal(m3.taxRatePct, 0);
    assert.equal(m3.totalWithTax, 90);
    assert.equal(res.amount, 203);
  });

  it('缺物资主数据的行不静默丢：计入 skippedRows 并带出名称', () => {
    const res = buildSettlementItemsFromDailyRows([
      { materialBaseId: 'm4', settleQty: 1, priceBeforeTax: 10, taxRate: 0 },
      { materialBaseId: null, materialName: '手工物资A', settleQty: 3, priceBeforeTax: 20, taxRate: 0 },
      { materialBaseId: '', materialName: '手工物资A', settleQty: 1, priceBeforeTax: 20, taxRate: 0 },
      { materialBaseId: null, materialName: '手工物资B', settleQty: 1 },
    ]);
    assert.equal(res.items.length, 1);
    assert.equal(res.skippedRowCount, 3);
    assert.deepEqual(res.skippedNames, ['手工物资A', '手工物资B']);
    assert.equal(res.amount, 10);
  });

  it('没有单价/金额时合价为 null，金额按 0 计（显式 0 仍是 0）', () => {
    const res = buildSettlementItemsFromDailyRows([
      { materialBaseId: 'm5', settleQty: 4 },
      { materialBaseId: 'm6', settleQty: 2, priceBeforeTax: 0, taxRate: 13 },
    ]);
    const m5 = res.items.find((i) => i.materialBaseId === 'm5')!;
    assert.equal(m5.qty, 4);
    assert.equal(m5.priceWithTax, null);
    assert.equal(m5.totalWithTax, null);
    const m6 = res.items.find((i) => i.materialBaseId === 'm6')!;
    assert.equal(m6.priceWithTax, 0);
    assert.equal(m6.totalWithTax, 0);
    assert.equal(res.amount, 0);
  });

  it('有金额但结算数量为空/0 的行不静默丢：计入 skippedNoQtyRowCount', () => {
    const res = buildSettlementItemsFromDailyRows([
      { materialBaseId: 'm7', settleQty: null, priceBeforeTax: 100, taxRate: 13, amountAfterTax: 500 },
      { materialBaseId: 'm8', settleQty: 0, priceBeforeTax: 50, taxRate: 0, amountAfterTax: 80 },
      { materialBaseId: 'm9', settleQty: 2, priceBeforeTax: 10, taxRate: 0 },
    ]);
    assert.equal(res.skippedNoQtyRowCount, 2);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].materialBaseId, 'm9');
    assert.equal(res.amount, 20);
  });

  it('空行返回空明细与 0 金额', () => {
    const res = buildSettlementItemsFromDailyRows([]);
    assert.deepEqual(res.items, []);
    assert.equal(res.amount, 0);
    assert.equal(res.skippedRowCount, 0);
    assert.equal(res.skippedNoQtyRowCount, 0);
  });
});
