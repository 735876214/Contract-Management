import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOverdue, interestOf } from '../src/common/utils/overdue-summary.ts';

/**
 * 逾期利息「汇总口径」单测（单一实现，供引擎 stats 与列表接口共用）。
 *
 * 起因：同一套汇总此前在 `overdue-calculator.recalculate().stats` 与
 * `finance.service.listOverdue().stats` 里各写一遍，且**「上期开累」取法不同**
 * （引擎取当前结算月首行；列表取"月份最大的那条手工期初"）→ 手工期初填在较早月份时两处数字不一致。
 * 本测试锁定统一后的规则，并把"手工期初在较早月份"作为回归用例。
 */

const R = (settlementMonth: string, overdueInterest: number, extra: Record<string, unknown> = {}) => ({
  settlementMonth,
  overdueInterest,
  ...extra,
});

/** 列表场景的取值器：读行内已持久化的 overdueInterest */
const fromRow = (r: any) => interestOf(r);

describe('interestOf：单行计息额', () => {
  it('作废（waived）按 0 计', () => {
    assert.equal(interestOf({ waived: true, overdueInterest: 100 }), 0);
  });
  it('显式传入的值优先于行内字段（重算场景传"本次算出的值"）', () => {
    assert.equal(interestOf({ overdueInterest: 100 }, 55), 55);
    assert.equal(interestOf({ overdueInterest: 100 }), 100);
  });
  it('空值 / 非法值按 0 处理', () => {
    for (const v of [null, undefined, '', 'abc']) {
      assert.equal(interestOf({ overdueInterest: v as never }), 0);
    }
  });
});

describe('summarizeOverdue：合计与开累', () => {
  it('空输入返回全 0（不产生 NaN，currentMonth 为空串）', () => {
    const s = summarizeOverdue([], fromRow);
    assert.deepEqual(s, {
      totalMaterial: 0,
      totalPayment: 0,
      currentCumulative: 0,
      cumulativeByMonth: {},
      currentMonth: '',
      prevCumulative: 0,
      currentSettlement: 0,
    });
  });

  it('单月：开累 = 该月利息合计；上期开累 0；本期结算 = 开累', () => {
    const s = summarizeOverdue([R('2026-01', 100), R('2026-01', 20, { waived: true })], fromRow);
    assert.equal(s.currentCumulative, 100); // 作废行不计入
    assert.equal(s.prevCumulative, 0);
    assert.equal(s.currentSettlement, 100);
    assert.deepEqual(s.cumulativeByMonth, { '2026-01': 100 });
    assert.equal(s.currentMonth, '2026-01');
  });

  it('多月份：按月累计；上期开累 = 上一结算月开累；本期结算 = 本月新增', () => {
    const s = summarizeOverdue([R('2026-01', 118), R('2026-02', 26)], fromRow);
    assert.deepEqual(s.cumulativeByMonth, { '2026-01': 118, '2026-02': 144 });
    assert.equal(s.currentCumulative, 144);
    assert.equal(s.prevCumulative, 118);
    assert.equal(s.currentSettlement, 26);
  });

  it('当前结算月**首行**的手工期初覆盖上期开累', () => {
    const s = summarizeOverdue([R('2026-01', 118), R('2026-02', 26, { prevCumulative: 50 })], fromRow);
    assert.equal(s.prevCumulative, 50);
    assert.equal(s.currentSettlement, 94); // 144 − 50
  });

  it('**规则锁定**：手工期初填在较早月份、当前月首行为空时，上期开累仍取上一结算月开累（不取那条手工值）', () => {
    // 旧 listOverdue 会取"月份最大的手工期初"→ 得到 999；统一后按引擎口径应为 118
    const s = summarizeOverdue([R('2026-01', 118, { prevCumulative: 999 }), R('2026-02', 26)], fromRow);
    assert.equal(s.prevCumulative, 118);
    assert.equal(s.currentSettlement, 26);
  });

  it('材料款合计按行求和；付款合计只累加 paymentAmount > 0 的行', () => {
    const s = summarizeOverdue(
      [
        R('2026-01', 0, { materialAmount: 100000, paymentAmount: 6000 }),
        R('2026-01', 0, { materialAmount: 5000, paymentAmount: 0 }),
        R('2026-01', 0, { materialAmount: 0, paymentAmount: -1 }), // 引擎内部用作"已消费"标记，不能计入
      ],
      fromRow,
    );
    assert.equal(s.totalMaterial, 105000);
    assert.equal(s.totalPayment, 6000);
  });

  it('月份顺序按字符串升序（YYYY-MM 可直接比较），与传入行序无关', () => {
    const s = summarizeOverdue([R('2026-02', 26), R('2026-01', 118)], fromRow);
    assert.equal(s.currentMonth, '2026-02');
    assert.deepEqual(s.cumulativeByMonth, { '2026-01': 118, '2026-02': 144 });
    assert.equal(s.prevCumulative, 118);
  });

  it('重算场景：按"本次算出的值"汇总，而不是行内旧值', () => {
    const rows = [R('2026-01', 999), R('2026-02', 999)];
    const s = summarizeOverdue(rows, (_row, idx) => [118, 26][idx]);
    assert.equal(s.currentCumulative, 144);
    assert.equal(s.prevCumulative, 118);
  });

  it('两位小数在累计过程中即收敛（避免浮点尾差累积）', () => {
    const s = summarizeOverdue([R('2026-01', 0.1), R('2026-01', 0.2)], fromRow);
    assert.equal(s.currentCumulative, 0.3);
  });
});
