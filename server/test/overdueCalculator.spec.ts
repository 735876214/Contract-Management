import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  days360,
  addDays,
  payableDateOf,
  modeTranches,
  recalculate,
  type OverdueRowInput,
} from '../src/modules/finance/overdue-calculator';

/**
 * 逾期利息计算引擎单测（P3：金额计算补测，见 TODO.md P3-2）。
 *
 * 该引擎是纯函数，文件头固化了 8 条业务规则；本测试逐条锁定，重点覆盖**金额与天数**：
 * - 逾期天数用 DAYS360（每月 30 天 / 每年 360 天）
 * - 逾期起始日 = 应付款日 + 宽限期 + 1 天
 * - 利息（含税）= ROUND(计息金额 × 逾期天数 × 月利率 ÷ 30, 2)
 * - 有付款时计息金额 = 付款金额；没付完时剩余金额由「当月承载行」计息一次
 * - 付款按逾期起始日顺序分配，优先分配已逾期部分
 * - 作废（waived）行的利息不计入开累
 *
 * 期望值均为**手算**（公式与 DAYS360 人工推演），不是跑一遍取返回值——否则测试只能证明「没崩」。
 */

const ymd = (d: Date | null): string =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : 'null';

describe('DAYS360（每月 30 天 / 每年 360 天）', () => {
  it('同一日期为 0；整月为 30；整年为 360', () => {
    assert.equal(days360(new Date(2026, 0, 1), new Date(2026, 0, 1)), 0);
    assert.equal(days360(new Date(2026, 0, 1), new Date(2026, 1, 1)), 30);
    assert.equal(days360(new Date(2026, 0, 15), new Date(2027, 0, 15)), 360);
  });

  it('31 日按 30 日处理（US 方法），2 月最后一天亦按 30 日', () => {
    // 1/31 → 2/28：d1 记为 30，d2 保持 28 → 30 + (28-30) = 28
    assert.equal(days360(new Date(2026, 0, 31), new Date(2026, 1, 28)), 28);
    // 2/28（2 月最后一天）→ 3/31：d1 记 30；d1≥30 时 d2=31 也记 30 → 30
    assert.equal(days360(new Date(2026, 1, 28), new Date(2026, 2, 31)), 30);
    // 8/31 → 9/30：d1 记 30，d2=30 → 30
    assert.equal(days360(new Date(2026, 7, 31), new Date(2026, 8, 30)), 30);
  });

  it('跨月零头按 30 进制：2/2 → 4/1 = 59 天', () => {
    assert.equal(days360(new Date(2026, 1, 2), new Date(2026, 3, 1)), 59);
  });
});

describe('addDays / payableDateOf', () => {
  it('跨月加减天', () => {
    assert.equal(ymd(addDays(new Date(2026, 0, 31), 1)), '2026-02-01');
    assert.equal(ymd(addDays(new Date(2026, 2, 1), -1)), '2026-02-28');
  });

  it('结算月 + 偏移月 + 指定日 → 应付款日（跨年自动进位）', () => {
    assert.equal(ymd(payableDateOf('2026-01', 1, 25)), '2026-02-25');
    assert.equal(ymd(payableDateOf('2026-11', 3, 25)), '2027-02-25'); // 11 月 + 3 月 = 次年 2 月
    assert.equal(ymd(payableDateOf('2026-1', 0, 25)), '2026-01-25'); // 单位数月份亦可
  });

  it('非法结算月返回 null（不抛错）', () => {
    for (const bad of ['', '2026-01-25', '2026/01', 'abc', null as never, undefined as never]) {
      assert.equal(payableDateOf(bad as string, 0, 25), null, String(bad));
    }
  });
});

describe('标准付款模式 modeTranches', () => {
  it('100：次月 25 日一次性 100%', () => {
    assert.deepEqual(modeTranches('100'), { tranches: [{ ratio: 1, plusMonths: 1, day: 25 }] });
  });

  it('3382：第 3 个月 80% + 第 6 个月 20%（合计 100%）', () => {
    const t = modeTranches('3382');
    assert.deepEqual(t, {
      tranches: [
        { ratio: 0.8, plusMonths: 3, day: 25 },
        { ratio: 0.2, plusMonths: 6, day: 25 },
      ],
    });
    assert.equal(t!.tranches.reduce((s, x) => s + x.ratio, 0), 1);
  });

  it('自定义 / 未知模式返回 null（由调用方按合同参数处理）', () => {
    for (const m of [null, undefined, '', 'CUSTOM', '999']) assert.equal(modeTranches(m as string), null);
  });
});

describe('recalculate · 未付款：按剩余金额与 DAYS360 计息', () => {
  const base: OverdueRowInput[] = [
    // 主行（材料款）—— 应付款 10000，应付款日 2026-01-25
    { id: 'r1', settlementMonth: '2026-01', materialAmount: 10000, payableDate: '2026-01-25', periodSeq: 0 },
    // 承载行（资金费用行，materialAmount=0）：承担「剩余未付」的计息
    { id: 'r2', settlementMonth: '2026-01', materialAmount: 0, paymentAmount: 0, periodSeq: 1 },
  ];
  const opts = { monthlyRate: 0.006, graceDays: 7, asOfDate: new Date(2026, 3, 1) };

  it('逾期起始日 = 应付款日 + 宽限期(7) + 1 天 = 2026-02-02', () => {
    const { derived } = recalculate(base.map((r) => ({ ...r })), opts);
    assert.equal(ymd(derived.get(0)!.overdueStartDate), '2026-02-02');
    assert.equal(derived.get(0)!.payableAmount, 10000);
    assert.equal(derived.get(0)!.overdueInterest, 0); // 主行本身不计息
  });

  it('剩余 10000 计息：59 天 × 月利率 0.6% ÷ 30 = 118.00', () => {
    const { derived, stats } = recalculate(base.map((r) => ({ ...r })), opts);
    const carrier = derived.get(1)!;
    assert.equal(carrier.interestAmount, 10000);
    assert.equal(carrier.overdueDays, 59); // DAYS360(2026-02-02 → 2026-04-01)
    assert.equal(carrier.overdueInterest, 118); // 10000 × 59 × 0.006 ÷ 30
    assert.equal(stats.totalInterest, 118);
    assert.equal(stats.currentSettlement, 118);
    assert.equal(stats.prevCumulative, 0);
  });

  it('缺少当月承载行时，剩余金额不计息（引擎依赖前端每月提供一条承载行，此处显式化该假设）', () => {
    const onlyMain = [{ id: 'r1', settlementMonth: '2026-01', materialAmount: 10000, payableDate: '2026-01-25' }];
    const { derived, stats } = recalculate(onlyMain, opts);
    assert.equal(derived.get(0)!.interestAmount, null);
    assert.equal(stats.totalInterest, 0);
  });
});

describe('recalculate · 部分付款：按逾期顺序分配，剩余继续计息', () => {
  it('付 6000 于 2026-03-01 → 已付部分计 34.80（29 天），剩余 4000 计 47.20（59 天），合计 82.00', () => {
    const rows: OverdueRowInput[] = [
      { id: 'r1', settlementMonth: '2026-01', materialAmount: 10000, payableDate: '2026-01-25', periodSeq: 0 },
      { id: 'r2', settlementMonth: '2026-02', materialAmount: 0, paymentAmount: 6000, paymentDate: '2026-03-01', periodSeq: 0 },
      { id: 'r3', settlementMonth: '2026-01', materialAmount: 0, paymentAmount: 0, periodSeq: 1 },
    ];
    const { derived, stats } = recalculate(rows, {
      monthlyRate: 0.006,
      graceDays: 7,
      asOfDate: new Date(2026, 3, 1),
    });
    // 付款行：计息金额 = 付款金额；天数 = DAYS360(逾期起始日 2026-02-02 → 付款日 2026-03-01)
    // = (3-2)×30 + (1-2) = 29 天（2 月 → 3 月）
    const pay = derived.get(1)!;
    assert.equal(pay.interestAmount, 6000);
    assert.equal(pay.overdueDays, 29);
    assert.equal(pay.overdueInterest, 34.8); // 6000 × 29 × 0.006 ÷ 30
    // 承载行：承担剩余 4000，计到截止日 2026-04-01 = 59 天
    const carrier = derived.get(2)!;
    assert.equal(carrier.interestAmount, 4000);
    assert.equal(carrier.overdueInterest, 47.2); // 4000 × 59 × 0.006 ÷ 30
    assert.equal(stats.totalPayment, 6000);
    assert.equal(stats.totalMaterial, 10000);
    // 提前付款降低利息：全额未付到 4/1 为 118.00，3/1 付 6000 后合计 82.00
    assert.equal(stats.totalInterest, 82);
  });

  it('付款优先分配「已逾期」条目（overdueStart ≤ 付款日）', () => {
    // 两笔应付款：1 月（已逾期）与 3 月（付款日尚未到）
    const rows: OverdueRowInput[] = [
      { settlementMonth: '2026-01', materialAmount: 1000, payableDate: '2026-01-25', periodSeq: 0 },
      { settlementMonth: '2026-03', materialAmount: 1000, payableDate: '2026-03-25', periodSeq: 0 },
      { settlementMonth: '2026-01', materialAmount: 0, paymentAmount: 0, periodSeq: 1 },
      { settlementMonth: '2026-03', materialAmount: 0, paymentAmount: 0, periodSeq: 1 },
      { settlementMonth: '2026-02', materialAmount: 0, paymentAmount: 500, paymentDate: '2026-02-15', periodSeq: 0 },
    ];
    const { derived, stats } = recalculate(rows, {
      monthlyRate: 0.006,
      graceDays: 7,
      asOfDate: new Date(2026, 3, 1),
    });
    // 付款 500 全部落在 1 月那笔（其逾期起始 2026-02-02 ≤ 2026-02-15）
    // 天数 = DAYS360(2026-02-02 → 2026-02-15) = 13 → 500 × 13 × 0.006 ÷ 30 = 1.30
    assert.equal(derived.get(4)!.overdueDays, 13);
    assert.equal(derived.get(4)!.overdueInterest, 1.3);
    // 1 月承载行剩 500；3 月承载行仍是整笔 1000（未被提前占用）
    assert.equal(derived.get(2)!.interestAmount, 500);
    assert.equal(derived.get(3)!.interestAmount, 1000);
    assert.equal(stats.totalPayment, 500);
  });
});

describe('recalculate · 多月份开累与上期开累', () => {
  it('逐月累计；currentSettlement = 本月新增；prevCumulative = 上一结算月开累', () => {
    // 注意：本组**不传 id**——引擎按文档也可用于前端复算，必须按「入参下标」定位主行，
    // 而不是依赖 rowId（否则多条目场景会全部错取第一个条目）
    const rows: OverdueRowInput[] = [
      { settlementMonth: '2026-01', materialAmount: 10000, payableDate: '2026-01-25', periodSeq: 0 },
      { settlementMonth: '2026-01', materialAmount: 0, paymentAmount: 0, periodSeq: 1 },
      { settlementMonth: '2026-02', materialAmount: 5000, payableDate: '2026-02-25', periodSeq: 0 },
      { settlementMonth: '2026-02', materialAmount: 0, paymentAmount: 0, periodSeq: 1 },
    ];
    const { derived, stats } = recalculate(rows, {
      monthlyRate: 0.006,
      graceDays: 7,
      asOfDate: new Date(2026, 3, 1),
    });
    // 每个主行各自取到自己的应付款金额与逾期起始日（不能被别的条目顶替）
    assert.equal(derived.get(0)!.payableAmount, 10000);
    assert.equal(ymd(derived.get(0)!.overdueStartDate), '2026-02-02');
    assert.equal(derived.get(2)!.payableAmount, 5000);
    assert.equal(ymd(derived.get(2)!.overdueStartDate), '2026-03-05');

    // 1 月：10000 × 59 天 → 118；2 月：5000 × 26 天（3-05 → 4-01）× 0.006/30 → 26
    assert.equal(derived.get(1)!.overdueInterest, 118);
    assert.equal(derived.get(3)!.overdueInterest, 26);
    assert.deepEqual(stats.cumulativeByMonth, { '2026-01': 118, '2026-02': 144 });
    assert.equal(stats.totalInterest, 144);
    assert.equal(stats.prevCumulative, 118);
    assert.equal(stats.currentSettlement, 26);
  });

  it('作废（waived）行的利息不计入开累，但行内仍算出金额', () => {
    const rows: OverdueRowInput[] = [
      { settlementMonth: '2026-01', materialAmount: 10000, payableDate: '2026-01-25', periodSeq: 0 },
      { settlementMonth: '2026-01', materialAmount: 0, paymentAmount: 0, periodSeq: 1, waived: true },
    ];
    const { derived, stats } = recalculate(rows, {
      monthlyRate: 0.006,
      graceDays: 7,
      asOfDate: new Date(2026, 3, 1),
    });
    assert.equal(derived.get(1)!.overdueInterest, 118); // 行内仍算出
    assert.equal(stats.totalInterest, 0); // 但不计入合计/开累
    assert.deepEqual(stats.cumulativeByMonth, { '2026-01': 0 });
    assert.equal(stats.currentSettlement, 0);
  });

  it('月利率为 0 时利息为 0（不产生 NaN）', () => {
    const rows: OverdueRowInput[] = [
      { settlementMonth: '2026-01', materialAmount: 10000, payableDate: '2026-01-25', periodSeq: 0 },
      { settlementMonth: '2026-01', materialAmount: 0, paymentAmount: 0, periodSeq: 1 },
    ];
    const { derived, stats } = recalculate(rows, { monthlyRate: 0, graceDays: 7, asOfDate: new Date(2026, 3, 1) });
    assert.equal(derived.get(1)!.overdueInterest, 0);
    assert.equal(stats.totalInterest, 0);
  });

  it('空输入不抛错，返回全 0 统计', () => {
    const { stats } = recalculate([], { monthlyRate: 0.006, graceDays: 7, asOfDate: new Date(2026, 3, 1) });
    assert.equal(stats.totalMaterial, 0);
    assert.equal(stats.totalPayment, 0);
    assert.equal(stats.totalInterest, 0);
    assert.equal(stats.currentSettlement, 0);
  });
});
