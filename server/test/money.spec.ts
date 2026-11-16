import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountToChineseCapital, round, round2, round4 } from '../src/common/utils/money.ts';

/**
 * 金额四舍五入的口径锁（2026-10-20 第 4 轮审计）。
 *
 * 旧实现 `Math.round((n + Number.EPSILON) * p) / p` 有三个错：
 *   ① `Number.EPSILON` 是绝对量 2.22e-16，|n| ≥ 2 时小于该量级的 1 ulp，补不进去；
 *   ② 负数 `Math.round` 向 +∞ 取整 → 半值往 0 走，与 Excel 的「半值远离零」相反；
 *   ③ 大写金额复制了同一式子，还二次取整。
 * 这些用例就是按「Excel ROUND 怎么说」写的，不是按实现写的。
 */

describe('round：半值必须远离零（与 Excel ROUND 一致）', () => {
  it('8.165 → 8.17（旧实现给 8.16，因为 8.165*100=816.4999999999999）', () => {
    assert.equal(round(8.165, 2), 8.17);
  });

  it('1234567.005 → 1234567.01（旧实现丢 1 分）', () => {
    assert.equal(round(1234567.005, 2), 1234567.01);
  });

  it('负数对称：-1.005 → -1.01，-2.5 → -3（旧实现分别给 -1 与 -2）', () => {
    assert.equal(round(-1.005, 2), -1.01);
    assert.equal(round(-2.5, 0), -3);
    assert.equal(round(2.5, 0), 3);
  });

  it('正负成对相等：round(-x) === -round(x)', () => {
    for (const v of [0.005, 1.005, 2.675, 8.165, 99.995, 1234567.005]) {
      assert.equal(round(-v, 2), -(round(v, 2) as number));
    }
  });

  it('空值与非有限值返回 null（调用方用 ?? 0 兜底）', () => {
    assert.equal(round(null), null);
    assert.equal(round(undefined), null);
    assert.equal(round(Number.NaN), null);
    assert.equal(round(Number.POSITIVE_INFINITY), null);
  });

  it('round2 / round4 走同一实现，保留原精度', () => {
    assert.equal(round2(0.1 + 0.2), 0.3);
    assert.equal(round2(1234.5678), 1234.57);
    assert.equal(round4(0.00005), 0.0001);
    assert.equal(round2(0), 0);
  });
});

describe('amountToChineseCapital：大写金额与 round 同口径', () => {
  it('整元 / 角分 / 负数', () => {
    assert.equal(amountToChineseCapital(0), '零元整');
    assert.equal(amountToChineseCapital(1286000), '壹佰贰拾捌万陆仟元整');
    assert.equal(amountToChineseCapital(1234.56), '壹仟贰佰叁拾肆元伍角陆分');
    assert.equal(amountToChineseCapital(-1.01), '负壹元零壹分');
  });

  it('半值不再少一分：8.165 元按 8.17 元大写', () => {
    assert.equal(amountToChineseCapital(8.165), '捌元壹角柒分');
  });

  it('字符串入参与非有限值兜底', () => {
    assert.equal(amountToChineseCapital('100.5'), '壹佰元伍角整');
    assert.equal(amountToChineseCapital(Number.NaN), '零元整');
  });
});
