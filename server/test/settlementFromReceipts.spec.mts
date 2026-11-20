import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettlementItemsFromReceiptOrders } from '../src/common/utils/settlement-from-receipts.ts';

/**
 * 收领单 → 结算明细带出（业务口径 2026-11-21）：
 * 结算明细的来源从「只有总日报行」扩到「收领单明细优先、日报行兜底」，
 * 保证挂上收领单的结算单也能落出清单项级明细（量级闸门/合同链已结算量才有数据）。
 * 这里锁的是**取数优先级与聚合口径**，价格公式本身由 settlementFromDaily.spec 锁定。
 */
describe('结算明细 · 从收领单带出', () => {
  it('明细优先：数量取实收数量，单价/税率取明细，合价按明细综合总价', () => {
    const res = buildSettlementItemsFromReceiptOrders([
      {
        orderNo: 'SO1',
        details: [
          { materialId: 'm1', receivedQty: 2, priceBeforeTax: 1000, taxRatePct: 13, priceWithTax: 1130, totalPrice: 2260 },
        ],
      },
    ]);
    assert.equal(res.items.length, 1);
    const it = res.items[0];
    assert.equal(it.materialBaseId, 'm1');
    assert.equal(it.qty, 2);
    assert.equal(it.priceBeforeTax, 1000);
    assert.equal(it.taxRatePct, 13);
    assert.equal(it.priceWithTax, 1130);
    assert.equal(it.totalWithTax, 2260);
    assert.equal(res.amount, 2260);
    assert.equal(res.detailRowCount, 1);
    assert.equal(res.dailyFallbackOrderCount, 0);
    assert.equal(res.receiptOrderCount, 1);
    // 备注要能看出是从收领单来的，并带上单号（对账时反查来源）
    assert.match(it.remark, /收领单/);
    assert.match(it.remark, /SO1/);
  });

  it('明细缺物资主数据时退回该单的总日报行（不丢数量）', () => {
    const res = buildSettlementItemsFromReceiptOrders([
      {
        orderNo: 'SO2',
        details: [{ materialId: null, receivedQty: 5, priceBeforeTax: 10 }],
        dailyRows: [
          {
            materialBaseId: 'm9',
            settleQty: 5,
            priceBeforeTax: 10,
            taxRatePct: 13,
            amountAfterTax: 56.5,
            receiptNo: 'SO2',
          },
        ],
      },
    ]);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].materialBaseId, 'm9');
    assert.equal(res.items[0].qty, 5);
    assert.equal(res.items[0].totalWithTax, 56.5);
    assert.equal(res.detailRowCount, 0);
    assert.equal(res.dailyFallbackOrderCount, 1);
  });

  it('明细与日报都带不出时记账到 ordersWithoutItems，不静默丢', () => {
    const res = buildSettlementItemsFromReceiptOrders([
      { orderNo: 'SO3', details: [], dailyRows: [] },
      { orderNo: 'SO4', details: [{ materialId: '' , receivedQty: 1 }], dailyRows: [{ materialBaseId: null, settleQty: 1 }] },
    ]);
    assert.equal(res.items.length, 0);
    assert.equal(res.receiptOrderCount, 2);
    assert.deepEqual(res.ordersWithoutItems, ['SO3', 'SO4']);
  });

  it('同一物资跨多张收领单按数量加权聚合，只出一行', () => {
    const res = buildSettlementItemsFromReceiptOrders([
      { orderNo: 'SO5', details: [{ materialId: 'm1', receivedQty: 1, priceBeforeTax: 100, taxRatePct: 13, totalPrice: 113 }] },
      { orderNo: 'SO6', details: [{ materialId: 'm1', receivedQty: 3, priceBeforeTax: 200, taxRatePct: 13, totalPrice: 678 }] },
    ]);
    assert.equal(res.items.length, 1);
    const it = res.items[0];
    assert.equal(it.qty, 4);
    // 含税金额加权：(113 + 678) / 4 = 197.75 → 税前 = 197.75 / 1.13 = 175.0000 → 合价 700
    assert.equal(it.priceBeforeTax, 175);
    assert.equal(it.totalWithTax, 791);
    assert.equal(res.amount, 791);
    assert.equal(res.detailRowCount, 2);
  });

  it('负数量（退货/调出）照常参与聚合，净额为负也保留', () => {
    const res = buildSettlementItemsFromReceiptOrders([
      { orderNo: 'SO7', details: [{ materialId: 'm1', receivedQty: 10, priceBeforeTax: 100, taxRatePct: 0, totalPrice: 1000 }] },
      { orderNo: 'SO8', details: [{ materialId: 'm1', receivedQty: -4, priceBeforeTax: 100, taxRatePct: 0, totalPrice: -400 }] },
    ]);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].qty, 6);
    assert.equal(res.items[0].totalWithTax, 600);
    assert.equal(res.amount, 600);
  });

  it('收领单明细数量为空/为 0 的行不计入（计入 skippedNoQtyRowCount）', () => {
    const res = buildSettlementItemsFromReceiptOrders([
      { orderNo: 'SO9', details: [{ materialId: 'm1', receivedQty: null, priceBeforeTax: 100 }] },
    ]);
    assert.equal(res.items.length, 0);
    assert.equal(res.skippedNoQtyRowCount, 1);
  });

  it('空来源：不产生明细，也不报错', () => {
    const res = buildSettlementItemsFromReceiptOrders([]);
    assert.equal(res.items.length, 0);
    assert.equal(res.amount, 0);
    assert.equal(res.receiptOrderCount, 0);
    assert.deepEqual(res.ordersWithoutItems, []);
  });
});
