import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLedgerAmounts,
  deriveTaxSplit,
  sumInvoiceTax,
  chainContractTotal,
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
 * 处置沿用本仓已定口径（`amount-guard` 那次修复，.claude/rules/backend-conventions.md 的「金额上限」与「台账」两节）：
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

describe('台账税率拆分与合同额合计（链口径）', () => {
  it('税率未填 → 税前/进项税都是 null（不兜成 0%）；显式 0 照常参与计算', () => {
    assert.deepEqual(deriveTaxSplit(113000, null), { beforeTax: null, inputTax: null });
    assert.deepEqual(deriveTaxSplit(113000, ''), { beforeTax: null, inputTax: null });
    assert.deepEqual(deriveTaxSplit(113000, 0), { beforeTax: 113000, inputTax: 0 });
    // 税率单轨百分数：13 = 13%（旧小数口径 0.13 已废弃）
    assert.deepEqual(deriveTaxSplit(113000, 13), { beforeTax: 100000, inputTax: 13000 });
  });

  it('合同额合计：同一链只计一次（按链根，不看 isSupplement 标志）', () => {
    // 主合同 100 万 + 补充协议 changeAmount +5 万 → 主合同行 currentAmount 105 万；
    // 补充协议行即便填了自由 amount 20 万，也不得再相加
    const total = chainContractTotal([
      { id: 'main', rootId: 'main', currentAmount: 1050000 },
      { id: 'sup', rootId: 'main', currentAmount: 1050000 },
    ]);
    assert.equal(total, 1050000, '链金额只取一次');
    // 即使 isSupplement 标志缺失（历史/导入不一致），只要有 parentContractId 就归到同一个 root
    assert.equal(
      chainContractTotal([
        { id: 'main', rootId: 'main', currentAmount: 1050000 },
        { id: 'sup-broken-flag', rootId: 'main', currentAmount: 1050000 },
      ]),
      1050000,
      '判据只看链根，标志漂移不会重复计入',
    );
    assert.equal(
      chainContractTotal([
        { id: 'a', rootId: null, currentAmount: null },
        { id: 'b', rootId: 'b', currentAmount: null },
      ]),
      0,
      '主合同未填金额按未知处理（不计入），但也不能报错',
    );
  });
});

/**
 * 台账「开累发票税前金额 / 开累发票进项税额」= 发票派生（业务口径 2026-11-18）。
 * 取代旧的「开累结算额 × 合同税率」倒推；口径锁死在这里，service 只负责把有效票喂进来。
 */
describe('台账 · 开累发票税前金额与进项税额（发票派生）', () => {
  it('无有效发票 → 两列都是 0（没开票就是 0，不是"未知"）', () => {
    assert.deepEqual(sumInvoiceTax([]), { beforeTax: 0, inputTax: 0, incomplete: 0 });
  });

  it('票面税前齐全：逐张求和，进项税 = 含税 − 税前（逐张舍入再相加）', () => {
    const got = sumInvoiceTax([
      { amountBeforeTax: 100000, amountWithTax: 113000, taxRatePct: 13 },
      // 尾差票：13% 下 12345.67 × 1.13 = 13950.6071 → 票面 13950.61，进项税按票面倒扣
      { amountBeforeTax: 12345.67, amountWithTax: 13950.61, taxRatePct: 13 },
    ]);
    assert.equal(got.beforeTax, 112345.67);
    assert.equal(got.inputTax, 13000 + 1604.94, '进项税按票面 含税−税前，不用税前×税率（会差分位）');
    assert.equal(got.incomplete, 0);
  });

  it('缺税前但有 含税+税率 → 按 含税÷(1+税率) 反推（兼容历史/未填票面的票）', () => {
    const got = sumInvoiceTax([{ amountBeforeTax: null, amountWithTax: 109000, taxRatePct: 9 }]);
    assert.equal(got.beforeTax, 100000);
    assert.equal(got.inputTax, 9000);
    assert.equal(got.incomplete, 0);
  });

  it('税前、含税都没有 → 该票不计入；全批都算不出时两列为 null（未知不兜 0）', () => {
    const none = sumInvoiceTax([{ amountBeforeTax: null, amountWithTax: null, taxRatePct: 13 }]);
    assert.deepEqual(none, { beforeTax: null, inputTax: null, incomplete: 1 });
    // 同一批里有一张能算 → 合计只含已知部分，并报出算不出的行数
    const mixed = sumInvoiceTax([
      { amountBeforeTax: 100000, amountWithTax: 113000, taxRatePct: 13 },
      { amountBeforeTax: null, amountWithTax: null, taxRatePct: null },
    ]);
    assert.equal(mixed.beforeTax, 100000);
    assert.equal(mixed.inputTax, 13000);
    assert.equal(mixed.incomplete, 1, '算不出的行要报出来，导出标题据此提示"合计不含"');
  });

  it('显式 0 的税前是合法值（免税/零税率票），不当作未填', () => {
    const got = sumInvoiceTax([{ amountBeforeTax: 0, amountWithTax: 0, taxRatePct: 0 }]);
    assert.deepEqual(got, { beforeTax: 0, inputTax: 0, incomplete: 0 });
  });
});
