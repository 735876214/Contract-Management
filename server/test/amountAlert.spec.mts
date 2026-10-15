import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAmountAlert, ALERT_THRESHOLDS } from '../src/common/utils/amount-alert.ts';

/**
 * 合同金额红/黄预警的阈值锁（2026-10-15 业务给定）。
 *
 * | 级别 | 条件（**严格大于**） |
 * |---|---|
 * | 红 | 当前结算额 > 当前金额 × 110% 或 补充协议累计 > 主合同 × 130% |
 * | 黄 | 当前结算额 > 当前金额 × 80% 或 补充协议累计 > 主合同 × 110% |
 *
 * 边界是本文件的重点：**恰好等于阈值不预警**（"超过"不含等于）。
 */

/** 主合同 100 万、无补充协议 → 当前金额 = 100 万 */
const base = { mainAmount: 1_000_000, supplementTotal: 0, currentAmount: 1_000_000 };

describe('金额预警：结算额 / 合同当前金额', () => {
  it('未超 80% → 无预警', () => {
    const r = evaluateAmountAlert({ ...base, settledTotal: 700_000 });
    assert.equal(r.level, null);
    assert.equal(r.settledRatioPct, 70);
  });

  it('恰好 80% → **不**预警（严格大于）', () => {
    const r = evaluateAmountAlert({ ...base, settledTotal: 800_000 });
    assert.equal(r.level, null, '等于阈值不算"超过"');
    assert.equal(r.settledRatioPct, 80);
  });

  it('超过 80% → 黄', () => {
    const r = evaluateAmountAlert({ ...base, settledTotal: 800_010 });
    assert.equal(r.level, 'YELLOW');
    assert.match(r.reasons[0], /80%/);
  });

  it('恰好 110% → 黄（不是红）', () => {
    const r = evaluateAmountAlert({ ...base, settledTotal: 1_100_000 });
    assert.equal(r.level, 'YELLOW');
  });

  it('超过 110% → 红', () => {
    const r = evaluateAmountAlert({ ...base, settledTotal: 1_100_001 });
    assert.equal(r.level, 'RED');
    assert.match(r.reasons[0], /110%/);
  });
});

describe('金额预警：补充协议累计 / 主合同金额', () => {
  it('超过 110% → 黄', () => {
    const r = evaluateAmountAlert({
      mainAmount: 1_000_000,
      supplementTotal: 1_150_000,
      currentAmount: 2_150_000,
      settledTotal: 0,
    });
    assert.equal(r.level, 'YELLOW');
    assert.equal(r.supplementRatioPct, 115);
    assert.match(r.reasons[0], /补充协议/);
  });

  it('超过 130% → 红', () => {
    const r = evaluateAmountAlert({
      mainAmount: 1_000_000,
      supplementTotal: 1_310_000,
      currentAmount: 2_310_000,
      settledTotal: 0,
    });
    assert.equal(r.level, 'RED');
    assert.equal(r.supplementRatioPct, 131);
  });

  it('恰好 130% → 黄（不是红）', () => {
    const r = evaluateAmountAlert({
      mainAmount: 1_000_000,
      supplementTotal: 1_300_000,
      currentAmount: 2_300_000,
      settledTotal: 0,
    });
    assert.equal(r.level, 'YELLOW');
  });

  it('净减项（补充协议累计为负）不触发任何预警', () => {
    const r = evaluateAmountAlert({
      mainAmount: 1_000_000,
      supplementTotal: -200_000,
      currentAmount: 800_000,
      settledTotal: 0,
    });
    assert.equal(r.level, null);
    assert.equal(r.supplementRatioPct, -20);
  });
});

describe('金额预警：红黄优先级与"未知不当 0"', () => {
  it('两个条件都命中 → 红，且两条理由都在', () => {
    const r = evaluateAmountAlert({
      mainAmount: 1_000_000,
      supplementTotal: 1_500_000,
      currentAmount: 2_500_000,
      settledTotal: 3_000_000, // 120% of 250万
    });
    assert.equal(r.level, 'RED');
    assert.equal(r.reasons.length, 2);
  });

  it('合同当前金额未知（主合同未填）→ 除数为未知，不用结算额误报', () => {
    const r = evaluateAmountAlert({
      mainAmount: null,
      supplementTotal: 50_000,
      currentAmount: null,
      settledTotal: 999_999,
    });
    assert.equal(r.level, null, '分母未知时报"超 110%"就是编数字');
    assert.equal(r.settledRatioPct, null);
    assert.equal(r.supplementRatioPct, null);
  });

  it('主合同金额未知但结算额为 0 → 同样不预警', () => {
    const r = evaluateAmountAlert({ mainAmount: null, supplementTotal: 0, currentAmount: null, settledTotal: 0 });
    assert.equal(r.level, null);
  });

  it('金额为 0 的合同不因"除以 0"报红（分母为 0 直接跳过该条件）', () => {
    const r = evaluateAmountAlert({ mainAmount: 0, supplementTotal: 0, currentAmount: 0, settledTotal: 100 });
    assert.equal(r.level, null);
    assert.equal(r.settledRatioPct, null);
  });

  it('阈值常量与业务给定一致（改阈值必须改这里 + 通知业务）', () => {
    assert.deepEqual(ALERT_THRESHOLDS, {
      settled: { red: 1.1, yellow: 0.8 },
      supplement: { red: 1.3, yellow: 1.1 },
    });
  });

  it('比例按百分数两位小数返回（供工作台直接显示）', () => {
    const r = evaluateAmountAlert({ ...base, settledTotal: 833_333 });
    assert.equal(r.settledRatioPct, 83.33);
  });
});
