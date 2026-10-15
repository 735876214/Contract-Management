import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLedgerAmounts,
  isFilledNumber,
  ratioPctOrNull,
} from '../src/common/utils/ledger-derived.ts';

/**
 * 台账派生金额列的**口径锁**。
 *
 * 背景（2026-10-15）：台账把"合同未填金额"当成 0，产出两类错数——开发库实测复现：
 * 52 份合同里有 6 份 `amount IS NULL` 却各有 1 万审定结算 → 台账显示
 * 「已结算金额占合同比例 = 0%」（谎称未结算），而防超结闸门对同一批合同说的是
 * 「上限未知」（`contractChainAmount()` 返回 `null`）→ **同一件事两个相反结论**。
 *
 * 处置沿用本仓已定口径（`amount-guard` 那次修复，docs/09 §8.3 #1）：
 * **「未填金额」≠「0」**，是"不可计算/无上限"。本测试把这个口径钉死，
 * 防止有人再把 `null` 兜成 `0`（那正是缺陷的成因）。
 */

describe('台账派生金额口径（未填金额 ≠ 0）', () => {
  it('合同额未填（NULL）→ 100% 欠款与结算比例都不可计算，而不是 0 / 负数', () => {
    const r = deriveLedgerAmounts({
      amount: null,
      cumSettleAmount: 10000,
      cumPaidAmount: 0,
      auditedSettleAmount: 10000,
      payRatio: 1,
    });
    assert.equal(r.settleRatio, null, '有 1 万结算却报 0% 是本缺陷的原始症状');
    assert.equal(r.debt100, null, '未填金额时 0 − 已付款 会给出负数');
    assert.equal(r.amountFilled, false);
    // 与合同额无关的两列照常算
    assert.equal(r.payableAmount, 10000);
    assert.equal(r.paidRatio, 0, '确实没有付款 → 0% 是成立的事实');
  });

  it('未填金额 + 有付款 → 不再是负数', () => {
    const r = deriveLedgerAmounts({
      amount: null,
      cumSettleAmount: 5000,
      cumPaidAmount: 3000,
      auditedSettleAmount: 5000,
      payRatio: 1,
    });
    assert.equal(r.debt100, null);
    assert.equal(r.settleRatio, null);
  });

  it('空串（表单清空）与 NULL 同处理', () => {
    const r = deriveLedgerAmounts({
      amount: '  ',
      cumSettleAmount: 100,
      cumPaidAmount: 0,
      auditedSettleAmount: 100,
      payRatio: null,
    });
    assert.equal(r.amountFilled, false);
    assert.equal(r.settleRatio, null);
    assert.equal(r.payableAmount, null, '付款比例未填 → 应付款不可计算');
    assert.equal(r.unpaidAmount, null, '比例未填时按 0 算会得到 −已付款');
  });

  it('显式填 0 是**真实的 0**，照常参与计算（与 amount-guard 对 0 的处理一致）', () => {
    const zero = deriveLedgerAmounts({
      amount: 0,
      cumSettleAmount: 0,
      cumPaidAmount: 800,
      auditedSettleAmount: 0,
      payRatio: 1,
    });
    assert.equal(zero.amountFilled, true, '0 元合同是"已填"，不是"未填"');
    assert.equal(zero.debt100, -800, '0 元合同却付了 800 —— 负数正是该被看见的数据异常，不要抹平');
    assert.equal(zero.settleRatio, null, '分母是真实的 0 → 比例不可计算');

    const two = deriveLedgerAmounts({
      amount: 0,
      cumSettleAmount: 100,
      cumPaidAmount: 0,
      auditedSettleAmount: 100,
      payRatio: 0,
    });
    assert.equal(two.settleRatio, null, '分母为 0 时比例不可计算');
    assert.equal(two.payableAmount, 0, '付款比例显式填 0% → 应付款是真实的 0');
    assert.equal(two.unpaidAmount, 0, '0% 比例下应付未付 = 0 − 0 = 0（不是 null：比例是"已填的 0"）');
  });

  it('无结算时「已付款占结算比例」不可计算，而不是 0%', () => {
    const r = deriveLedgerAmounts({
      amount: 1000,
      cumSettleAmount: 0,
      cumPaidAmount: 500,
      auditedSettleAmount: 0,
      payRatio: null,
    });
    assert.equal(r.paidRatio, null, '一笔都没结算时，0% 是个没有依据的断言');
    assert.equal(r.settleRatio, 0, '合同额已填、结算为 0 → 0% 是事实');
  });

  it('常规场景的数值与修复前的算式逐位一致（回归）', () => {
    const r = deriveLedgerAmounts({
      amount: 1200000,
      cumSettleAmount: 450000.555,
      cumPaidAmount: 300000,
      auditedSettleAmount: 450000,
      payRatio: 0.8,
    });
    assert.equal(r.debt100, 900000);
    assert.equal(r.settleRatio, 37.5);
    assert.equal(r.paidRatio, 66.67);
    assert.equal(r.payableAmount, 360000);
    assert.equal(r.unpaidAmount, 60000);
  });

  it('比例与欠款都保留两位小数（与导出/前端显示一致）', () => {
    const r = deriveLedgerAmounts({
      amount: 3,
      cumSettleAmount: 1,
      cumPaidAmount: 0,
      auditedSettleAmount: 1,
      payRatio: 0.333,
    });
    assert.equal(r.settleRatio, 33.33);
    assert.equal(r.payableAmount, 0.33);
  });
});

describe('台账派生口径的两个小工具', () => {
  it('isFilledNumber：0 算已填，null/undefined/空串/非数算未填', () => {
    for (const v of [0, '0', 1, '12.5', -3]) assert.equal(isFilledNumber(v), true, `${v} 应算已填`);
    for (const v of [null, undefined, '', '   ', 'abc', NaN, Infinity]) {
      assert.equal(isFilledNumber(v), false, `${String(v)} 应算未填`);
    }
  });

  it('ratioPctOrNull：分母为 0/缺失 → null（不返回 0）', () => {
    assert.equal(ratioPctOrNull(5, 0), null);
    assert.equal(ratioPctOrNull(5, 10), 50);
    assert.equal(ratioPctOrNull(0, 10), 0);
  });
});
