import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSupplementDelta } from '../src/common/utils/supplement-delta.ts';

/**
 * 补充协议「带符号增量」的算法锁（2026-10-15 业务澄清：变更要结构化）。
 *
 * 关键回归：**涨价/降价只能计差额**。若按"剩余数量 × 新单价"计入，
 * 主合同里那部分数量的原值就重复算了一遍，"合同当前金额"会偏大。
 */

/** 主合同：A 物资 100 元、B 物资 50 元 */
const parentRows = [
  { materialBaseId: 'A', qty: 100, priceWithTax: 100, totalWithTax: 10000 },
  { materialBaseId: 'B', qty: 200, priceWithTax: 50, totalWithTax: 10000 },
];

describe('补充协议增量（带符号）', () => {
  it('涨价：只计差额 × 数量（不是新价全值）', () => {
    const d = computeSupplementDelta({
      typeCode: 'PRICE_UP',
      suppRows: [{ materialBaseId: 'A', qty: 60, priceWithTax: 120 }],
      parentRows,
    });
    // (120 − 100) × 60 = 1200；若误按新价全值算会得到 7200
    assert.equal(d.amount, 1200);
    assert.equal(d.qty, 0, '改价不改量');
    assert.equal(d.basis, 'PRICE_DIFF');
  });

  it('降价：差价为负 → 增量为负（当前金额应随之下降）', () => {
    const d = computeSupplementDelta({
      typeCode: 'PRICE_DOWN',
      suppRows: [{ materialBaseId: 'B', qty: 200, priceWithTax: 45 }],
      parentRows,
    });
    assert.equal(d.amount, -1000);
  });

  it('增数量：按**原合同单价** × 新增数量', () => {
    const d = computeSupplementDelta({
      typeCode: 'QTY_ADD',
      suppRows: [{ materialBaseId: 'A', qty: 30, priceWithTax: 999 }],
      parentRows,
    });
    assert.equal(d.amount, 3000, '原价 100 × 30，不采信行内那个 999');
    assert.equal(d.qty, 30);
    assert.equal(d.basis, 'QTY_FULL');
  });

  it('新增物资：按含税合价全额计入', () => {
    const d = computeSupplementDelta({
      typeCode: 'ITEM_ADD',
      suppRows: [
        { materialBaseId: 'C', qty: 5, priceWithTax: 20, totalWithTax: 100 },
        { materialBaseId: 'D', qty: 2, priceWithTax: 300, totalWithTax: 600 },
      ],
      parentRows,
    });
    assert.equal(d.amount, 700);
    assert.equal(d.qty, 7);
    assert.equal(d.basis, 'ITEM_FULL');
  });

  it('价格类变更里主合同查不到的物资 → 按全额计并计数（不静默丢弃）', () => {
    const d = computeSupplementDelta({
      typeCode: 'PRICE_UP',
      suppRows: [
        { materialBaseId: 'A', qty: 10, priceWithTax: 110 }, // 差额 100
        { materialBaseId: 'Z', qty: 3, priceWithTax: 40, totalWithTax: 120 }, // 主合同没有 → 全额 120
      ],
      parentRows,
    });
    assert.equal(d.amount, 220);
    assert.equal(d.unmatchedRows, 1);
  });

  it('富文本/其他类型：不产生金额增量', () => {
    const d = computeSupplementDelta({
      typeCode: 'OTHER',
      suppRows: [{ materialBaseId: 'A', qty: 1, priceWithTax: 1000, totalWithTax: 1000 }],
      parentRows,
    });
    assert.equal(d.amount, 0);
    assert.equal(d.qty, 0);
    assert.equal(d.basis, 'NONE');
  });

  it('类型缺失或未知：一律 0（宁可少算金额，不猜）', () => {
    for (const typeCode of [null, undefined, '', 'WHATEVER']) {
      const d = computeSupplementDelta({ typeCode, suppRows: [{ qty: 9, priceWithTax: 9 }], parentRows });
      assert.equal(d.amount, 0, `${String(typeCode)} 应不产生增量`);
    }
  });

  it('缺 totalWithTax 时用「单价 × 数量」兜底，且保留两位小数', () => {
    const d = computeSupplementDelta({
      typeCode: 'ITEM_ADD',
      suppRows: [{ materialBaseId: 'C', qty: 3, priceWithTax: 33.333 }],
      parentRows,
    });
    assert.equal(d.amount, 100, '3 × 33.333 = 99.999 → 100.00');
  });
});
