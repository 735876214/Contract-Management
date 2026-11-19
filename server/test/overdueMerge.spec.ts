import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOverdueRowsByMonth } from '../src/modules/finance/overdue-merge';

/**
 * 逾期利息台账「按合同 + 结算月合并成一行」单测。
 *
 * 引擎里一个逾期项常由「材料款主行 + 付款行/计息承载行」两条记录组成，
 * 展示层要求同一合同同一结算月只出一行；本测试锁定合并口径：
 * 金额求和、日期取最早（多笔付款取最晚并在备注列出全部）、逾期天数取最大、保留原始 ids。
 */
const materialRow = {
  id: 'm1',
  contractId: 'c1',
  settlementMonth: '2025-05',
  periodSeq: 0,
  materialAmount: 279593.4,
  paymentRatio: 1,
  payableAmount: 279593.4,
  payableDate: '2025-06-25',
  overdueStartDate: '2025-07-03',
  paymentDate: null,
  paymentAmount: null,
  interestAmount: 0,
  overdueDays: 0,
  monthlyRate: 0.009,
  overdueInterest: 0,
  waived: false,
  remark: null,
};

const paymentRow = {
  id: 'p1',
  contractId: 'c1',
  settlementMonth: '2025-05',
  periodSeq: 1,
  materialAmount: 0,
  paymentRatio: null,
  payableAmount: 0,
  payableDate: null,
  overdueStartDate: '2025-07-03',
  paymentDate: '2025-10-09',
  paymentAmount: 279593.4,
  interestAmount: 279593.4,
  overdueDays: 96,
  monthlyRate: 0.009,
  overdueInterest: 8052.29,
  waived: false,
  remark: null,
};

describe('mergeOverdueRowsByMonth', () => {
  it('同一合同同一结算月的主行 + 付款行合并为一行', () => {
    const out = mergeOverdueRowsByMonth([materialRow as any, paymentRow as any]);
    assert.equal(out.length, 1);
    const r: any = out[0];
    assert.equal(r.id, 'm1'); // 取材料款主行 id
    assert.deepEqual(r.ids, ['m1', 'p1']);
    assert.equal(r.materialAmount, 279593.4);
    assert.equal(r.payableAmount, 279593.4);
    assert.equal(new Date(r.payableDate).toISOString().slice(0, 10), '2025-06-25');
    assert.equal(new Date(r.overdueStartDate).toISOString().slice(0, 10), '2025-07-03');
    assert.equal(new Date(r.paymentDate).toISOString().slice(0, 10), '2025-10-09');
    assert.equal(r.paymentAmount, 279593.4);
    assert.equal(r.interestAmount, 279593.4);
    assert.equal(r.overdueDays, 96);
    assert.equal(r.overdueInterest, 8052.29);
    assert.equal(r.monthlyRate, 0.009);
  });

  it('不同结算月各自成行', () => {
    const out = mergeOverdueRowsByMonth([
      { ...materialRow } as any,
      { ...materialRow, id: 'm2', settlementMonth: '2025-06' } as any,
    ]);
    assert.equal(out.length, 2);
  });

  it('不同合同（同一结算月）不合并', () => {
    const out = mergeOverdueRowsByMonth([
      { ...materialRow } as any,
      { ...paymentRow, contractId: 'c2' } as any,
    ]);
    assert.equal(out.length, 2);
  });

  it('单行原样返回（同一引用）', () => {
    const single: any = { ...materialRow };
    const out = mergeOverdueRowsByMonth([single]);
    assert.equal(out.length, 1);
    assert.equal(out[0], single);
  });

  it('多月多笔付款：金额求和、逾期天数取最大、备注列出各笔付款日期', () => {
    const out = mergeOverdueRowsByMonth([
      { ...materialRow } as any,
      { ...paymentRow } as any,
      {
        ...paymentRow,
        id: 'p2',
        paymentDate: '2025-11-20',
        paymentAmount: 1000,
        interestAmount: 1000,
        overdueDays: 120,
        overdueInterest: 100,
      } as any,
    ]);
    assert.equal(out.length, 1);
    const r: any = out[0];
    assert.equal(r.paymentAmount, 280593.4); // 279593.4 + 1000
    assert.equal(r.overdueInterest, 8152.29);
    assert.equal(r.overdueDays, 120); // 取最大
    assert.equal(r.paymentDate.toISOString().slice(0, 10), '2025-11-20'); // 最晚
    assert.ok(String(r.remark).includes('2025-10-09'));
    assert.ok(String(r.remark).includes('2025-11-20'));
  });
});
