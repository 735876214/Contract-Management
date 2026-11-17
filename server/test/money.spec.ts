import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountToChineseCapital, round, round2, round4 } from '../src/common/calc/money.ts';
import {
  calcAmount,
  calcPriceWithTax,
  calcRateNullable,
  calcTotalWithTax,
  mulDecimal,
  canonicalMonthKey,
  compareMonthKey,
  groupSumByMonth,
  groupSumByYear,
  monthSequence,
  fmtAmount,
  fmtRate,
  parseMonthKey,
  settlementAmountOf,
  sortMonthKeys,
  sumRounded,
} from '../src/common/calc/index.ts';

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

describe('共享计算原语 golden case', () => {
  it('含税单价与合价：任一入参缺失不臆造 0，精度由调用方显式指定', () => {
    assert.equal(calcPriceWithTax(10, 13), 11.3);
    assert.equal(calcTotalWithTax(11.3, 3), 33.9);
    assert.equal(calcTotalWithTax(11.3, 3, 2), 33.9);
    assert.equal(calcPriceWithTax(10, null), null);
    assert.equal(calcTotalWithTax(null, 3), null);
  });

  it('合价走整数分精确乘法，消除 1.005*3 的 double 边界（字符串 Decimal 直接吃）', () => {
    assert.equal(calcAmount('10', 3), 30);
    assert.equal(calcAmount(3.015, 1), 3.02);
    assert.equal(calcAmount(2.675, 1), 2.68);
    assert.equal(sumRounded([0.1, 0.2, 0.3]), 0.6);
    // 旧口径：1.005*3 的 double 是 3.0149999999999997，round 后得 3.01；
    // 整数分精确乘法按十进制算 3.015 → 3.02，与 Excel ROUND 一致。
    assert.equal(calcAmount('1.005', 3), 3.02);
    assert.equal(calcAmount(1.005, 3), 3.02);
  });

  it('mulDecimal 十进制精确乘法：不再有浮点乘法尾差', () => {
    assert.equal(mulDecimal('1.005', 3, 2), 3.02);
    assert.equal(mulDecimal(0.1, 0.2, 2), 0.02);
    assert.equal(mulDecimal('1234567.005', 3, 2), 3703701.02);
    assert.equal(mulDecimal('-1.005', 3, 2), -3.02);
    assert.equal(mulDecimal('2.675', 1, 2), 2.68);
    assert.equal(mulDecimal('0.0001', '0.0001', 8), 0.00000001);
    assert.equal(mulDecimal('1e-7', 2, 8), 0.0000002);
    assert.equal(mulDecimal(null, 3), null);
    assert.equal(mulDecimal('abc', 3), null);
    assert.equal(mulDecimal(0, 3.5, 2), 0);
    assert.equal(mulDecimal('-2', '-3', 2), 6);
  });

  it('税率单轨百分数：含税公式直接吃 13（=13%），不再有小数↔百分数双轨', () => {
    assert.equal(calcPriceWithTax(100, 13), 113);
    assert.equal(calcPriceWithTax(100, 9), 109);
    assert.equal(calcPriceWithTax(100, null), null);
  });

  it('比率零分母策略：占比返回 0，差额比率返回 null', () => {
    assert.equal(calcRateNullable(0, 5), null);
    assert.equal(calcRateNullable(100, 80), 20);
    assert.equal(calcRateNullable(null, 80), null);
  });

  it('月份键严格校验，排序只认零补齐的 YYYY-MM', () => {
    assert.equal(parseMonthKey('2026-09'), '2026-09');
    assert.equal(parseMonthKey('2026-9'), null);
    assert.equal(parseMonthKey('2026-13'), null);
    assert.deepEqual(['2026-10', '2026-02', '2026-01'].sort(compareMonthKey), [
      '2026-01',
      '2026-02',
      '2026-10',
    ]);
  });

  it('格式化只负责展示，空值不显示 0.00', () => {
    assert.equal(fmtAmount(1234.5), '1,234.50');
    assert.equal(fmtAmount(null), '');
    assert.equal(fmtRate(12.345), '12.35%');
  });
});

describe('统一月度聚合原语', () => {
  it('自由文本月份归一后再排序，`2026-10` 不再排在 `2026-9` 前', () => {
    assert.equal(canonicalMonthKey('2026-9'), '2026-09');
    assert.equal(canonicalMonthKey('2026年9月'), '2026-09');
    assert.equal(canonicalMonthKey('202609'), '2026-09');
    assert.equal(canonicalMonthKey('abc'), null);
    assert.deepEqual(['2026-10', '2026-9', '2026-01'].map(canonicalMonthKey).sort(compareMonthKey), [
      '2026-01',
      '2026-09',
      '2026-10',
    ]);
    assert.deepEqual(sortMonthKeys(['', '2026-10', '2026-09'], true), ['', '2026-09', '2026-10']);
  });

  it('同月不同合同/材料进入同一分组；金额按 Decimal 字符串求和并收敛精度', () => {
    const rows = [
      { contract: 'A', material: '水泥', month: '2026-09', amount: '0.1' },
      { contract: 'A', material: '钢材', month: '2026-9', amount: '0.2' },
      { contract: 'B', material: '水泥', month: '2026/09', amount: '1.005' },
      { contract: 'B', material: '钢材', month: 'bad', amount: 999 },
    ];
    assert.deepEqual(
      groupSumByMonth(rows, { monthOf: (r) => r.month, amountOf: (r) => r.amount }),
      { '2026-09': 1.31 },
    );
    // 未知月份可显式保留，但不会混进正常月份
    assert.deepEqual(
      groupSumByMonth(rows, { monthOf: (r) => r.month, amountOf: (r) => r.amount, keepUnknown: true }),
      { '2026-09': 1.31, '': 999 },
    );
    assert.deepEqual(
      groupSumByYear(rows, { monthOf: (r) => r.month, amountOf: (r) => r.amount }),
      { '2026': 1.31 },
    );
  });

  it('近 N 个月序列按本地月份生成（跨年不跳月）', () => {
    assert.deepEqual(monthSequence(new Date(2026, 0, 31), 3), ['2025-11', '2025-12', '2026-01']);
    assert.deepEqual(monthSequence('invalid', 0), []);
  });

  it('结算金额来源优先级：审定与送审分别声明，空串不当成缺失', () => {
    assert.equal(settlementAmountOf({ actualAmount: '10.5', amount: 99 }, 'actual'), 10.5);
    assert.equal(settlementAmountOf({ actualAmount: '10.5', amount: 99 }, 'submitted'), 99);
    assert.equal(settlementAmountOf({ actualAmount: null, amount: '2.675' }), 2.675);
    assert.equal(settlementAmountOf({ actualAmount: 0, amount: 99 }), 0);
    assert.equal(settlementAmountOf({ actualAmount: '', amount: 99 }), null);
  });
});
