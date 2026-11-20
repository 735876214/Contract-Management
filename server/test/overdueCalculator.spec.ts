import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  days360,
  addDays,
  payableDateOf,
  modeTranches,
  recalculatePayables,
  recomputePayableRows,
  type OverduePayableInput,
  type OverduePaymentInput,
} from '../src/modules/finance/overdue-calculator';

/**
 * 逾期利息计算引擎单测（主子表版：应付款项 + 付款流水）。
 *
 * 该引擎是纯函数，文件头固化了几条业务规则；本测试逐条锁定，重点覆盖**金额与天数**：
 * - 逾期天数用 DAYS360（每月 30 天 / 每年 360 天）
 * - 逾期起始日 = 应付款日 + 宽限期 + 1 天
 * - 利息（含税）= ROUND(计息金额 × 逾期天数 × 月利率 ÷ 30, 2)
 * - 付款流水**跨期自动分配**：先补已逾期（overdueStart ≤ 付款日）的期，再补未到期的期
 * - 每一期各自的「已付部分」按付款日计息、「未付余额」按截止日计息，二者相加为该期利息
 * - 作废（waived）期仍然算出金额，但不计入开累
 *
 * 期望值均为**手算**（公式与 DAYS360 人工推演），不是跑一遍取返回值——否则测试只能证明「没崩」。
 */

const ymd = (d: Date | null): string =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : 'null';

/** 常用参数：月利率 0.6%、宽限期 7 天、截止 2026-04-01 */
const opt = (asOfDate = new Date(2026, 3, 1), extra: Record<string, number> = {}) => ({
  monthlyRate: 0.006,
  graceDays: 7,
  asOfDate,
  ...extra,
});

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

describe('recalculatePayables · 未付款：按应付款金额与 DAYS360 计息', () => {
  const payables: OverduePayableInput[] = [
    // 一期：材料款 100%，应付款日 2026-01-25
    { id: 'p1', settlementMonth: '2026-01', periodSeq: 1, materialAmount: 10000, paymentRatio: 1, payableDate: '2026-01-25' },
  ];

  it('逾期起始日 = 应付款日 + 宽限期(7) + 1 天 = 2026-02-02', () => {
    const { derived } = recalculatePayables(payables, [], opt());
    const d = derived.get(0)!;
    assert.equal(ymd(d.overdueStartDate), '2026-02-02');
    assert.equal(d.payableAmount, 10000);
    assert.equal(d.paidAmount, 0);
    assert.equal(d.remaining, 10000);
  });

  it('10000 计息：59 天 × 月利率 0.6% ÷ 30 = 118.00', () => {
    const { derived, stats } = recalculatePayables(payables, [], opt());
    const d = derived.get(0)!;
    assert.equal(d.interestAmount, 10000);
    assert.equal(d.overdueDays, 59); // DAYS360(2026-02-02 → 2026-04-01)
    assert.equal(d.overdueInterest, 118); // 10000 × 59 × 0.006 ÷ 30
    assert.equal(stats.totalInterest, 118);
    assert.equal(stats.currentSettlement, 118);
    assert.equal(stats.prevCumulative, 0);
    assert.equal(stats.totalMaterial, 10000);
    assert.equal(stats.totalPayment, 0);
  });

  it('未到逾期起始日（尚未逾期）不计息，不产生负数天数', () => {
    // 应付款日 2026-03-25 → 逾期起始 2026-04-02，晚于截止日 2026-04-01
    const rows: OverduePayableInput[] = [
      { settlementMonth: '2026-03', periodSeq: 1, materialAmount: 1000, paymentRatio: 1, payableDate: '2026-03-25' },
    ];
    const { derived, stats } = recalculatePayables(rows, [], opt());
    assert.equal(derived.get(0)!.overdueDays, 0);
    assert.equal(derived.get(0)!.overdueInterest, 0);
    assert.equal(stats.totalInterest, 0);
  });

  it('缺少应付款日期 / 材料款为 0 的期不派生任何金额（与写库置空口径一致）', () => {
    const rows: OverduePayableInput[] = [
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 10000 }, // 无应付日期
      { settlementMonth: '2026-01', periodSeq: 2, materialAmount: 0, payableDate: '2026-01-25' },
    ];
    const { derived, stats } = recalculatePayables(rows, [], opt());
    assert.equal(derived.size, 0);
    assert.equal(stats.totalInterest, 0);
  });
});

describe('recalculatePayables · 部分付款：已付按付款日计息，余额按截止日计息', () => {
  const payables: OverduePayableInput[] = [
    { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 10000, paymentRatio: 1, payableDate: '2026-01-25' },
  ];
  const payments: OverduePaymentInput[] = [
    { id: 'pay1', paymentDate: '2026-03-01', paymentAmount: 6000 },
  ];

  it('付 6000 于 2026-03-01 → 已付部分 34.80（29 天），余额 4000 计 47.20（59 天），合计 82.00', () => {
    const { derived, stats } = recalculatePayables(payables, payments, opt());
    const d = derived.get(0)!;
    // 付款片段：天数 = DAYS360(逾期起始 2026-02-02 → 付款日 2026-03-01) = 29
    assert.equal(d.chunks.length, 1);
    assert.equal(d.chunks[0].amount, 6000);
    assert.equal(d.chunks[0].overdueDays, 29);
    assert.equal(d.chunks[0].interest, 34.8); // 6000 × 29 × 0.006 ÷ 30
    // 余额按截止日 2026-04-01 = 59 天
    assert.equal(d.paidAmount, 6000);
    assert.equal(d.remaining, 4000);
    assert.equal(d.interestAmount, 10000); // 计息金额 = 已付 + 余额 = 应付款金额
    assert.equal(d.overdueDays, 59); // 取「已付片段天数」与「余额天数」的较大者
    assert.equal(d.overdueInterest, 82); // 34.80 + 47.20
    assert.equal(stats.totalPayment, 6000); // 付款合计取付款流水口径
    // 提前付款降低利息：全额未付到 4/1 为 118.00，3/1 付 6000 后合计 82.00
    assert.equal(stats.totalInterest, 82);
  });
});

describe('recalculatePayables · 付款跨期分配', () => {
  it('优先分配「已逾期」的期（overdueStart ≤ 付款日），未到期的期不被提前占用', () => {
    const payables: OverduePayableInput[] = [
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 1000, paymentRatio: 1, payableDate: '2026-01-25' }, // start 02-02
      { settlementMonth: '2026-03', periodSeq: 1, materialAmount: 1000, paymentRatio: 1, payableDate: '2026-03-25' }, // start 04-02
    ];
    const payments: OverduePaymentInput[] = [{ paymentDate: '2026-02-15', paymentAmount: 500 }];
    const { derived, stats } = recalculatePayables(payables, payments, opt());
    // 500 全部落在 1 月那期：DAYS360(2026-02-02 → 2026-02-15) = 13 → 500 × 13 × 0.006 ÷ 30 = 1.30
    const jan = derived.get(0)!;
    assert.equal(jan.paidAmount, 500);
    assert.equal(jan.chunks[0].overdueDays, 13);
    assert.equal(jan.chunks[0].interest, 1.3);
    // 1 月余额 500 继续计到 4/1（59 天）= 5.90 → 该期合计 7.20
    assert.equal(jan.remaining, 500);
    assert.equal(jan.overdueInterest, 7.2);
    // 3 月那期完全没被占用
    const mar = derived.get(1)!;
    assert.equal(mar.paidAmount, 0);
    assert.equal(mar.remaining, 1000);
    assert.equal(stats.totalPayment, 500);
  });

  it('一笔付款可跨两期分配：先补第一期余额，余下补第二期；提前付款的天数按 0 计', () => {
    // 3382 式拆期：80% 在 2026-04-25（start 05-02），20% 在 2026-07-25（start 08-01）
    const payables: OverduePayableInput[] = [
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 8000, paymentRatio: 0.8, payableDate: '2026-04-25' },
      { settlementMonth: '2026-01', periodSeq: 2, materialAmount: 2000, paymentRatio: 0.2, payableDate: '2026-07-25' },
    ];
    const payments: OverduePaymentInput[] = [{ paymentDate: '2026-06-01', paymentAmount: 9000 }];
    const { derived } = recalculatePayables(payables, payments, opt());
    const p1 = derived.get(0)!;
    const p2 = derived.get(1)!;
    assert.equal(p1.paidAmount, 8000);
    assert.equal(p1.remaining, 0);
    assert.equal(p1.chunks[0].overdueDays, 28); // DAYS360(逾期起始 05-03 → 06-01)
    assert.equal(p1.chunks[0].interest, 44.8); // 8000 × 28 × 0.006 ÷ 30
    assert.equal(p1.overdueInterest, 44.8);
    // 第二期未到期就被先付掉 1000：不计罚息（负数天数按 0 处理）
    assert.equal(p2.paidAmount, 1000);
    assert.equal(p2.remaining, 1000);
    assert.equal(p2.chunks[0].overdueDays, 0);
    assert.equal(p2.chunks[0].interest, 0);
  });

  it('付款超过应付总额时不产生负余额，多出部分被忽略', () => {
    const payables: OverduePayableInput[] = [
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 1000, paymentRatio: 1, payableDate: '2026-01-25' },
    ];
    const payments: OverduePaymentInput[] = [{ paymentDate: '2026-02-15', paymentAmount: 3000 }];
    const { derived, stats } = recalculatePayables(payables, payments, opt());
    const d = derived.get(0)!;
    assert.equal(d.paidAmount, 1000);
    assert.equal(d.remaining, 0);
    assert.equal(d.overdueInterest, 2.6); // 1000 × 13 × 0.006 ÷ 30
    assert.equal(stats.totalPayment, 3000); // 流水口径照实汇总
  });
});

describe('recalculatePayables · 多月份开累与上期开累', () => {
  it('逐月累计；currentSettlement = 本月新增；prevCumulative = 上一结算月开累', () => {
    // 注意：**不传 id**——引擎也可用于前端复算，必须按「入参下标」定位，而不是依赖数据库 id
    const payables: OverduePayableInput[] = [
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 10000, paymentRatio: 1, payableDate: '2026-01-25' },
      { settlementMonth: '2026-02', periodSeq: 1, materialAmount: 5000, paymentRatio: 1, payableDate: '2026-02-25' },
    ];
    const { derived, stats } = recalculatePayables(payables, [], opt());
    assert.equal(derived.get(0)!.payableAmount, 10000);
    assert.equal(ymd(derived.get(0)!.overdueStartDate), '2026-02-02');
    assert.equal(derived.get(1)!.payableAmount, 5000);
    assert.equal(ymd(derived.get(1)!.overdueStartDate), '2026-03-05');

    // 1 月：10000 × 59 天 → 118；2 月：5000 × 26 天（3-05 → 4-01）× 0.006 ÷ 30 → 26
    assert.equal(derived.get(0)!.overdueInterest, 118);
    assert.equal(derived.get(1)!.overdueInterest, 26);
    assert.deepEqual(stats.cumulativeByMonth, { '2026-01': 118, '2026-02': 144 });
    assert.equal(stats.totalInterest, 144);
    assert.equal(stats.prevCumulative, 118);
    assert.equal(stats.currentSettlement, 26);
  });

  it('作废（waived）期的利息不计入开累，但行内仍算出金额', () => {
    const payables: OverduePayableInput[] = [
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 10000, paymentRatio: 1, payableDate: '2026-01-25', waived: true },
    ];
    const { derived, stats } = recalculatePayables(payables, [], opt());
    assert.equal(derived.get(0)!.overdueInterest, 118); // 行内仍算出
    assert.equal(stats.totalInterest, 0); // 但不计入合计/开累
    assert.deepEqual(stats.cumulativeByMonth, { '2026-01': 0 });
    assert.equal(stats.currentSettlement, 0);
  });

  it('月利率为 0 时利息为 0（不产生 NaN）', () => {
    const payables: OverduePayableInput[] = [
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 10000, paymentRatio: 1, payableDate: '2026-01-25' },
    ];
    const { derived, stats } = recalculatePayables(payables, [], opt(new Date(2026, 3, 1), { monthlyRate: 0 }));
    assert.equal(derived.get(0)!.overdueInterest, 0);
    assert.equal(stats.totalInterest, 0);
  });

  it('应付款金额 = 该期材料款金额（拆期比例在写入前已拆到材料款上，引擎不再乘一次）', () => {
    // 录入「本月材料款 1000 × 80%」→ 服务端落库 materialAmount=800、paymentRatio=0.8
    const one = recalculatePayables(
      [{ settlementMonth: '2026-01', periodSeq: 1, materialAmount: 800, paymentRatio: 0.8, payableDate: '2026-01-25' }], [], opt());
    assert.equal(one.derived.get(0)!.payableAmount, 800, '不能再乘一次 0.8（否则 640）');
    // 未填比例（手工整笔录入）同样按材料款金额
    const two = recalculatePayables(
      [{ settlementMonth: '2026-01', periodSeq: 1, materialAmount: 1000, payableDate: '2026-01-25' }], [], opt());
    assert.equal(two.derived.get(0)!.payableAmount, 1000);
    // 同一月的两期材料款相加 = 整笔材料款，卡片口径才与旧台账一致
    const both = recalculatePayables([
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 800, paymentRatio: 0.8, payableDate: '2026-01-25' },
      { settlementMonth: '2026-01', periodSeq: 2, materialAmount: 200, paymentRatio: 0.2, payableDate: '2026-04-25' },
    ], [], opt());
    assert.equal(both.stats.totalMaterial, 1000);
  });

  it('空输入不抛错，返回全 0 统计', () => {
    const { stats } = recalculatePayables([], [], opt());
    assert.equal(stats.totalMaterial, 0);
    assert.equal(stats.totalPayment, 0);
    assert.equal(stats.totalInterest, 0);
    assert.equal(stats.currentSettlement, 0);
  });

  it('stats 与列表接口同形：含 cap 字段；截止日必须显式注入', () => {
    const payables: OverduePayableInput[] = [
      { settlementMonth: '2026-01', periodSeq: 1, materialAmount: 10000, paymentRatio: 1, payableDate: '2026-01-25' },
    ];
    const { stats } = recalculatePayables(payables, [], opt(new Date(2026, 3, 1), { interestCapRatio: 0.05 }));
    assert.equal(stats.capRatio, 0.05);
    assert.equal(stats.capAmount, 500);
    assert.equal(stats.capUsage, 23.6);
    assert.equal(stats.currentMonth, '2026-01');
    assert.throws(
      () => recalculatePayables(payables, [], { monthlyRate: 0.006, graceDays: 7 } as never),
      /asOfDate/,
    );
  });
});

describe('recomputePayableRows · 读时重算消除派生列陈旧值', () => {
  const payables = [
    // 库内上次写入的陈旧派生值 99/1 必须在读时被覆盖，不能沿用
    {
      id: 'p1', settlementMonth: '2026-01', periodSeq: 1, materialAmount: 10000, paymentRatio: 1,
      payableDate: '2026-01-25', overdueInterest: 99, overdueDays: 1,
    } as unknown as OverduePayableInput,
  ];

  it('按 asOfDate 现算派生列并覆盖库内陈旧值（不是读上次写入）', () => {
    const { rows: fresh } = recomputePayableRows(payables.map((p) => ({ ...p })), [], opt());
    assert.equal(fresh[0].overdueInterest, 118);
    assert.equal(fresh[0].overdueDays, 59);
    assert.equal(fresh[0].interestAmount, 10000);
  });

  it('同一批数据，截止日越晚未付完的利息越大（读时重算随日期增长）', () => {
    const at = (d: Date) =>
      recomputePayableRows(payables.map((p) => ({ ...p })), [], opt(d)).rows[0].overdueInterest;
    const apr1 = at(new Date(2026, 3, 1)); // 59 天
    const may1 = at(new Date(2026, 4, 1)); // 89 天（DAYS360: 2/02 → 5/01）
    const jun1 = at(new Date(2026, 5, 1)); // 119 天
    assert.equal(apr1, 118); // 10000 × 59 × 0.006 ÷ 30
    assert.equal(may1, 178); // 10000 × 89 × 0.006 ÷ 30
    assert.equal(jun1, 238); // 10000 × 119 × 0.006 ÷ 30
    assert.ok(apr1 < may1 && may1 < jun1, '未付完的利息必须随 asOfDate 单调增长');
  });

  it('引擎判定不派生的期被置空，杜绝「行已不算逾期利息还在」', () => {
    const stale = [
      {
        id: 'p0', settlementMonth: '2026-01', periodSeq: 1,
        materialAmount: 0, payableAmount: 500, overdueDays: 30, overdueInterest: 99,
      } as unknown as OverduePayableInput,
    ];
    const { rows: fresh } = recomputePayableRows(stale, [], opt());
    assert.equal(fresh[0].payableAmount, null);
    assert.equal(fresh[0].overdueDays, null);
    assert.equal(fresh[0].overdueInterest, null);
  });

  it('重算返回的 stats 与引擎 recalculatePayables 完全一致（同一口径）', () => {
    const { stats: viaView } = recomputePayableRows(payables.map((p) => ({ ...p })), [], opt());
    const { stats: viaEngine } = recalculatePayables(payables.map((p) => ({ ...p })), [], opt());
    assert.deepEqual(viaView, viaEngine);
  });
});
