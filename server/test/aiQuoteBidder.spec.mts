/**
 * 课题 3-9（采购报价与价差）规则层单测：**零 DB、零 IO**，`npm test` 直接跑。
 *
 * 三层断言：
 * ① 金额/比例原语（半进位、分母非正、回退链）；
 * ② 夹具真值（12 条注入异常逐条对上 code + entityId + 任务号）；
 * ③ 容差与降级（阈值可覆盖；坏数据不抛错；干净任务一条都不命中）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bidderTotalCents,
  fmtBp,
  ratioBpOf,
  resolveQuoteTolerances,
} from '../src/modules/ai/quote/quote-types.ts';
import {
  budgetCentsOf,
  evaluateQuoteAnomalies,
  b2SpreadAnomalies,
} from '../src/modules/ai/quote/rules-quote.ts';
import { cleanQuoteFixture, quoteAnomalyFixture, quoteTruth } from './fixtures/ai-quote-bidder.fixture.mts';

const codes = (findings: Array<{ code: string }>) => findings.map((f) => f.code).sort();
const keys = (findings: Array<{ code: string; taskNo: string; entityId: string }>) =>
  findings.map((f) => `${f.taskNo}|${f.code}|${f.entityId}`).sort();

// ------------------------------------------------------------------ 原语

test('ratioBpOf：半进位、负数保号、分母非正返回 null', () => {
  assert.equal(ratioBpOf(2000n, 10_000n), 2000); // 20.00%
  assert.equal(ratioBpOf(1n, 8n), 1250); // 12.50%
  assert.equal(ratioBpOf(-6000n, 10_000n), -6000);
  assert.equal(ratioBpOf(1n, 3n), 3333); // 33.333…% → 33.33%
  assert.equal(ratioBpOf(1n, 0n), null);
  assert.equal(ratioBpOf(1n, -5n), null);
});

test('fmtBp：两位小数百分比，负数带号', () => {
  assert.equal(fmtBp(2000), '20.00%');
  assert.equal(fmtBp(1563), '15.63%');
  assert.equal(fmtBp(-400), '-4.00%');
  assert.equal(fmtBp(0), '0.00%');
});

test('bidderTotalCents：最终价 → 第二轮 → 第一轮 回退链', () => {
  assert.equal(bidderTotalCents({ id: 'a', finalPreTaxTotal: 300, secondPreTaxTotal: 200, firstPreTaxTotal: 100 }), 30_000n);
  assert.equal(bidderTotalCents({ id: 'b', secondPreTaxTotal: 200, firstPreTaxTotal: 100 }), 20_000n);
  assert.equal(bidderTotalCents({ id: 'c', firstPreTaxTotal: 100 }), 10_000n);
  assert.equal(bidderTotalCents({ id: 'd' }), null);
});

test('budgetCentsOf：缺数量或缺单价的行跳过，一行都用不上返回 null', () => {
  const items = [
    { id: '1', qty: 100, planPrice: 1000 },
    { id: '2', qty: 200, planPrice: 500 },
    { id: '3', planPrice: 900 }, // 缺数量 → 跳过
    { id: '4', qty: 5 }, // 缺单价 → 跳过
  ];
  assert.equal(budgetCentsOf(items), 200_000_00n); // 100×1000 + 200×500 = 200000 元
  assert.equal(budgetCentsOf([{ id: 'x', qty: 1 }]), null);
  assert.equal(budgetCentsOf([]), null);
});

test('resolveQuoteTolerances：非法值兜底为默认，负数金额不放行', () => {
  const def = resolveQuoteTolerances();
  assert.equal(def.amount, 100n);
  assert.equal(def.dropPct, 20);
  const merged = resolveQuoteTolerances({ dropPct: Number.NaN, amount: -5n, minBidders: 0 });
  assert.equal(merged.dropPct, def.dropPct);
  assert.equal(merged.amount, def.amount);
  assert.equal(merged.minBidders, 1); // 下限夹到 1
});

// ------------------------------------------------------------------ 夹具真值

test('夹具真值：12 条注入异常逐条命中（code + 任务号 + entityId 全等）', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  const want = quoteTruth().map((t) => `${t.taskNo}|${t.code}|${t.entityId}`).sort();
  assert.deepEqual(keys(r.findings), want);
  assert.equal(r.summary.total, 12);
});

test('夹具汇总：2 高风险 / 10 需复核，十二条规则码各命中一次', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  assert.equal(r.summary.high, 2);
  assert.equal(r.summary.medium, 10);
  assert.deepEqual(Object.keys(r.summary.byCode).sort(), [
    'B1_DROP_EXCESS',
    'B1_DROP_INVERTED',
    'B2_SPREAD_TOO_LOW',
    'B3_OVER_BUDGET',
    'B3_UNDER_BUDGET',
    'B4_PRICE_OVER_CONTROL',
    'B4_PRICE_VS_MARKET',
    'B5_TAX_RATE_DRIFT',
    'B5_TAX_RATE_INVALID',
    'B6_NOT_LOWEST',
    'B7_FEW_BIDDERS',
    'B7_WINNER_NO_PRICE',
  ]);
  for (const [code, n] of Object.entries(r.summary.byCode)) assert.equal(n, 1, code);
});

test('干净任务：0 命中、0 未判定（负向断言比正向更能挡住误报）', () => {
  const r = evaluateQuoteAnomalies({ tasks: cleanQuoteFixture() });
  assert.deepEqual(r.findings, []);
  assert.equal(r.summary.total, 0);
  assert.deepEqual(r.notEvaluated, []);
});

// ------------------------------------------------------------------ 逐规则定向

test('B1：降幅 25% 命中、二轮倒挂命中，差额与方向写在事实里', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  const excess = r.findings.find((f) => f.code === 'B1_DROP_EXCESS');
  assert.ok(excess);
  assert.equal(excess.taskNo, 'HT-CG-2026-001');
  assert.equal(excess.entityId, 'bd-001');
  assert.equal(excess.entity, 'bidder');
  assert.equal(excess.amountDiff, '60000.00');
  assert.ok(excess.facts.some((x) => x.includes('25.00%')));

  const inverted = r.findings.find((f) => f.code === 'B1_DROP_INVERTED');
  assert.ok(inverted);
  assert.equal(inverted.amountDiff, '3000.00');
  assert.ok(inverted.facts.some((x) => x.includes('二轮比一轮高')));
});

test('B2：报价高度一致只在 T2 命中，事实里列出各家报价与离散系数', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  const spread = r.findings.filter((f) => f.code === 'B2_SPREAD_TOO_LOW');
  assert.equal(spread.length, 1);
  assert.equal(spread[0].taskNo, 'HT-CG-2026-002');
  assert.equal(spread[0].entity, 'task');
  assert.ok(spread[0].facts.some((x) => x.includes('离散系数')));
  assert.ok(spread[0].facts.some((x) => x.includes('乙公司')));
});

test('B2：家数不足下限时不判定，并写明原因', () => {
  const out = b2SpreadAnomalies(
    {
      task: { id: 't', taskNo: 'HT-CG-X' },
      bidders: [{ id: 'b1', bidderName: '甲公司', firstPreTaxTotal: 100 }],
    },
    resolveQuoteTolerances(),
  );
  assert.deepEqual(out.findings, []);
  assert.ok(out.notEvaluated[0].includes('不足 3 家'));
});

test('B3：超控制价差额 5000、显著偏低差额 70000（都用 final/第二轮口径）', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  const over = r.findings.find((f) => f.code === 'B3_OVER_BUDGET');
  assert.ok(over);
  assert.equal(over.level, 'HIGH');
  assert.equal(over.amountDiff, '5000.00');

  const under = r.findings.find((f) => f.code === 'B3_UNDER_BUDGET');
  assert.ok(under);
  assert.equal(under.level, 'MEDIUM');
  assert.equal(under.amountDiff, '70000.00');
  assert.ok(under.title.includes('65.00%')); // 占控制价的比例写在标题上，facts 里是绝对差额
});

test('B4：单行超控制价按数量合计（200×50=10000 元），单价偏离按市场价算百分比', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  const overControl = r.findings.find((f) => f.code === 'B4_PRICE_OVER_CONTROL');
  assert.ok(overControl);
  assert.equal(overControl.entity, 'totalItem');
  assert.equal(overControl.amountDiff, '10000.00');
  assert.ok(overControl.facts.some((x) => x.includes('2200.00')));

  const vsMarket = r.findings.find((f) => f.code === 'B4_PRICE_VS_MARKET');
  assert.ok(vsMarket);
  assert.equal(vsMarket.taskNo, 'HT-CG-2026-003');
  assert.ok(vsMarket.facts.some((x) => x.includes('16.67%')));
});

test('B5：税率 15.63% 判为不在集合；两轮 13% → 9% 判为口径漂移', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  const invalid = r.findings.find((f) => f.code === 'B5_TAX_RATE_INVALID');
  assert.ok(invalid);
  assert.equal(invalid.entityId, 'bd-023');
  assert.ok(invalid.facts.some((x) => x.includes('15.63%')));

  const drift = r.findings.find((f) => f.code === 'B5_TAX_RATE_DRIFT');
  assert.ok(drift);
  assert.equal(drift.entityId, 'bd-021');
  assert.ok(drift.facts.some((x) => x.includes('13.00%')));
  assert.ok(drift.facts.some((x) => x.includes('9.00%')));
});

test('B6：非最低价中标差额 1000，命中单位是中标单位本身', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  const f = r.findings.find((x) => x.code === 'B6_NOT_LOWEST');
  assert.ok(f);
  assert.equal(f.entityId, 'bd-011');
  assert.equal(f.amountDiff, '1000.00');
  assert.ok(f.facts.some((x) => x.includes('乙公司')));
});

test('B7：家数不足报在任务上，中标缺报价报在单位上；T4 其余规则转未判定', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  const few = r.findings.find((f) => f.code === 'B7_FEW_BIDDERS');
  assert.ok(few);
  assert.equal(few.entity, 'task');
  assert.equal(few.entityId, 'task-q-004');
  const noPrice = r.findings.find((f) => f.code === 'B7_WINNER_NO_PRICE');
  assert.ok(noPrice);
  assert.equal(noPrice.entityId, 'bd-031');

  const t4 = r.notEvaluated.filter((s) => s.includes('HT-CG-2026-004'));
  assert.equal(t4.length, 5); // B1 / B2 / B3 / B4 / B6
  assert.ok(t4.some((s) => s.includes('B3 未判定')));
  assert.equal(r.notEvaluated.length, 5);
});

// ------------------------------------------------------------------ 容差与降级

test('容差可覆盖：放宽降幅与金额、关掉离散度与家数，对应命中消失', () => {
  const r = evaluateQuoteAnomalies({
    tasks: quoteAnomalyFixture(),
    tolerances: { dropPct: 30, spreadPct: 0, underBudgetPct: 0, minBidders: 1, amount: 1_000_000n },
  });
  // 金额容差只影响「按金额判定」的三条；单价与市场价的偏离是比例判定，不受 amount 影响
  assert.deepEqual(codes(r.findings), [
    'B1_DROP_INVERTED',
    'B4_PRICE_VS_MARKET',
    'B5_TAX_RATE_DRIFT',
    'B5_TAX_RATE_INVALID',
    'B7_WINNER_NO_PRICE',
  ].sort());
});

test('坏数据不中断：报价列填了非数字、清单价格缺项，其余任务照常出结论', () => {
  const tasks = quoteAnomalyFixture().map((t) => {
    if (t.task.taskNo !== 'HT-CG-2026-005') return t;
    return {
      ...t,
      bidders: t.bidders.map((b) => ({ ...b, firstPreTaxTotal: '不是数字', secondPreTaxTotal: '' })),
      items: [{ id: 'bad', materialBaseId: 'mb-041', qty: null, planPrice: 'abc' }],
    };
  });
  const r = evaluateQuoteAnomalies({ tasks });
  // 其余四个任务的真值一条不少（坏数据只影响被改的那个任务）
  for (const t of quoteTruth()) {
    assert.ok(
      keys(r.findings).includes(`${t.taskNo}|${t.code}|${t.entityId}`),
      `真值丢失：${t.taskNo} ${t.code}`,
    );
  }
  // 被改坏的任务从「干净」退化为「家数不足 + 中标缺报价」——降级要看得见，不能静默
  const broken = r.findings.filter((f) => f.taskNo === 'HT-CG-2026-005');
  assert.deepEqual(broken.map((f) => f.code).sort(), ['B7_FEW_BIDDERS', 'B7_WINNER_NO_PRICE']);
  assert.ok(r.notEvaluated.some((s) => s.includes('HT-CG-2026-005')));
});

test('每条事实都带单位：金额「元」、比例「%」（模型只许照抄，不许自己算）', () => {
  const r = evaluateQuoteAnomalies({ tasks: quoteAnomalyFixture() });
  for (const f of r.findings) {
    assert.ok(f.facts.length >= 2, f.code);
    assert.ok(
      f.facts.some((x) => /[\d]/.test(x) && /(元|%|家|条)/.test(x)),
      `${f.code} 的事实里没有任何可引用的数字`,
    );
  }
});
