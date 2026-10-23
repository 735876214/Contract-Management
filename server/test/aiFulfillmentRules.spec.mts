/**
 * 履约偏差预警（课题 4-9）规则层单测。
 *
 * 两类断言：
 * 1. **夹具真值**——人工标注的命中条数/等级/规则码必须完全一致（改动判定就会红）；
 * 2. **边界定向**——每条规则的阈值边界各测两侧（宽限期、滞后容忍、付款差额），
 *    防止「阈值写反了/单位错了」这类只在边界上暴露的错误。
 *
 * 规则层不读系统时钟（`now` 注入），所以这些断言不随日期漂移。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  c1Overdue,
  c4FinishLate,
  c6ProgressPaymentGap,
  c7SettledUnfinished,
  c8NoMilestone,
  evaluateFulfillmentAnomalies,
  sortFulfillmentFindings,
} from '../src/modules/ai/fulfillment/rules-fulfillment.ts';
import { resolveFulfillmentTolerances } from '../src/modules/ai/fulfillment/fulfillment-types.ts';
import type { FulfillmentContractRow, FulfillmentInput, MilestoneRow } from '../src/modules/ai/fulfillment/fulfillment-types.ts';
import {
  FIXTURE_EXPECTED_BY_CODE,
  FIXTURE_EXPECTED_HIGH,
  FIXTURE_EXPECTED_MEDIUM,
  FIXTURE_EXPECTED_TOTAL,
  FIXTURE_NOW,
  cleanFulfillmentFixture,
  fulfillmentFixture,
} from './fixtures/ai-fulfillment.fixture.mts';

const ctx = () => ({ now: FIXTURE_NOW, tol: resolveFulfillmentTolerances(), notEvaluated: [] as string[] });

const contractMap = (rows: FulfillmentContractRow[]) => new Map(rows.map((c) => [c.id, c]));

test('履约偏差 · 夹具真值：10 条命中，高风险 3 / 需复核 7，8 个规则码全覆盖', () => {
  const input = fulfillmentFixture();
  const result = evaluateFulfillmentAnomalies(input);
  assert.equal(result.summary.total, FIXTURE_EXPECTED_TOTAL);
  assert.equal(result.summary.high, FIXTURE_EXPECTED_HIGH);
  assert.equal(result.summary.medium, FIXTURE_EXPECTED_MEDIUM);
  assert.deepEqual(result.summary.byCode, FIXTURE_EXPECTED_BY_CODE);
  // 每条命中都必须有可读标题与事实行（面板与模型都靠它）
  for (const f of result.findings) {
    assert.ok(f.title.length > 0, `${f.code} 缺标题`);
    assert.ok(f.facts.length >= 2, `${f.code} 事实行过少`);
  }
});

test('履约偏差 · 干净夹具零命中，且没有未判定规则', () => {
  const result = evaluateFulfillmentAnomalies(cleanFulfillmentFixture());
  assert.equal(result.summary.total, 0);
  assert.deepEqual(result.notEvaluated, []);
});

test('履约偏差 · 顺序稳定（同一输入两次跑结果完全相同）', () => {
  const a = evaluateFulfillmentAnomalies(fulfillmentFixture());
  const b = evaluateFulfillmentAnomalies(fulfillmentFixture());
  assert.deepEqual(a.findings, b.findings);
  const sorted = sortFulfillmentFindings(a.findings);
  // 高风险在前
  const firstMedium = sorted.findIndex((f) => f.level === 'MEDIUM');
  const lastHigh = sorted.map((f) => f.level).lastIndexOf('HIGH');
  assert.ok(firstMedium === -1 || lastHigh < firstMedium);
});

test('履约偏差 · C1 宽限期边界：逾期 = 宽限天数不报，宽限 + 1 天才报', () => {
  const contracts: FulfillmentContractRow[] = [
    { id: 'c1', code: 'HT-1', name: 'X', amount: 100, signDate: '2026-01-01', signedDate: '2026-01-01' },
  ];
  const map = contractMap(contracts);
  const tol = resolveFulfillmentTolerances(); // graceDays = 7

  const exactlyGrace: MilestoneRow[] = [
    // 2026-10-17 + 7 天 = 2026-10-24（基准日）→ 逾期 7 天，不报
    { id: 'm1', contractId: 'c1', name: '节点', planDate: '2026-10-17', statusCode: 'PENDING' },
  ];
  assert.equal(c1Overdue(exactlyGrace, map, ctx()).length, 0);

  const overGrace: MilestoneRow[] = [
    { id: 'm2', contractId: 'c1', name: '节点', planDate: '2026-10-16', statusCode: 'PENDING' },
  ];
  const hits = c1Overdue(overGrace, map, ctx());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].code, 'C1_OVERDUE');
  assert.equal(hits[0].level, 'MEDIUM');

  // 逾期 31 天 → 升级高风险
  const highRisk: MilestoneRow[] = [
    { id: 'm3', contractId: 'c1', name: '节点', planDate: '2026-09-23', statusCode: 'PENDING' },
  ];
  const high = c1Overdue(highRisk, map, ctx());
  assert.equal(high.length, 1);
  assert.equal(high[0].level, 'HIGH');
  assert.ok(high[0].facts.some((f) => f.includes('逾期天数：31 天')));
  assert.equal(tol.graceDays, 7);
});

test('履约偏差 · C1 已跳过（SKIPPED）与已完成（DONE）的节点不算逾期', () => {
  const map = contractMap([{ id: 'c1', code: 'HT-1', name: 'X' }]);
  const rows: MilestoneRow[] = [
    { id: 'a', contractId: 'c1', name: '已跳过', planDate: '2026-01-01', statusCode: 'SKIPPED' },
    { id: 'b', contractId: 'c1', name: '已完成', planDate: '2026-01-01', actualDate: '2026-01-02', statusCode: 'DONE' },
  ];
  assert.equal(c1Overdue(rows, map, ctx()).length, 0);
});

test('履约偏差 · C4 滞后容忍边界：等于容忍天数不报，多 1 天才报', () => {
  const map = contractMap([{ id: 'c1', code: 'HT-1', name: 'X' }]);
  // lateFinishDays = 7
  const exactly: MilestoneRow[] = [
    { id: 'm1', contractId: 'c1', name: '节点', planDate: '2026-03-01', actualDate: '2026-03-08', statusCode: 'DONE' },
  ];
  assert.equal(c4FinishLate(exactly, map, ctx()).length, 0);

  const over: MilestoneRow[] = [
    { id: 'm2', contractId: 'c1', name: '节点', planDate: '2026-03-01', actualDate: '2026-03-09', statusCode: 'DONE' },
  ];
  const hits = c4FinishLate(over, map, ctx());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].level, 'MEDIUM');
  assert.ok(hits[0].facts.some((f) => f.includes('滞后天数：8 天')));
});

test('履约偏差 · C6 付款快于履约：差额等于阈值不报，超出才报，缺合同金额写未判定', () => {
  // 完成率 50%（1 done / 1 open），付款比例 80% → 差 30 = 阈值，不报
  const base: FulfillmentInput = {
    now: FIXTURE_NOW,
    contracts: [{ id: 'c1', code: 'HT-1', name: 'X', amount: 1_000 }],
    milestones: [
      { id: 'm1', contractId: 'c1', name: 'A', planDate: '2026-01-01', actualDate: '2026-01-01', statusCode: 'DONE' },
      { id: 'm2', contractId: 'c1', name: 'B', planDate: '2026-12-31', statusCode: 'PENDING' },
    ],
    payments: [{ id: 'p1', contractId: 'c1', amount: 800, statusCode: 'PAID' }],
  };
  const atThreshold = ctx();
  assert.equal(c6ProgressPaymentGap(base, atThreshold).length, 0);

  // 付款 900 / 1_000 = 90% → 差 40 ≥ 30 → 命中，且不足 50 个百分点，等级需复核
  const over: FulfillmentInput = { ...base, payments: [{ id: 'p1', contractId: 'c1', amount: 900, statusCode: 'PAID' }] };
  const hits = c6ProgressPaymentGap(over, ctx());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].code, 'C6_PROGRESS_PAYMENT_GAP');
  assert.equal(hits[0].level, 'MEDIUM');

  // 合同金额未填 → 不算比例，写进未判定（不猜）
  const noAmount: FulfillmentInput = {
    ...over,
    contracts: [{ id: 'c1', code: 'HT-1', name: 'X', amount: null }],
  };
  const ctxNoAmount = ctx();
  assert.equal(c6ProgressPaymentGap(noAmount, ctxNoAmount).length, 0);
  assert.ok(ctxNoAmount.notEvaluated.some((n) => n.includes('合同金额未填或为 0')));
});

test('履约偏差 · C7 草稿终期结算不算「已结算」', () => {
  const contracts = contractMap([{ id: 'c1', code: 'HT-1', name: 'X' }]);
  const input: FulfillmentInput = {
    now: FIXTURE_NOW,
    contracts: [{ id: 'c1', code: 'HT-1', name: 'X' }],
    milestones: [{ id: 'm1', contractId: 'c1', name: '验收', planDate: '2026-12-31', statusCode: 'PENDING' }],
    finalSettlements: [{ id: 'fs1', contractId: 'c1', statusCode: 'DRAFT' }],
  };
  assert.equal(c7SettledUnfinished(input, contracts).length, 0);
});

test('履约偏差 · C8 未签订且无节点的合同不报（没有履约义务就不该有节点）', () => {
  const contracts = contractMap([
    { id: 'c1', code: 'HT-1', name: '草稿', signDate: null, signedDate: null, status: 'DRAFT' },
  ]);
  const input: FulfillmentInput = {
    now: FIXTURE_NOW,
    contracts: [{ id: 'c1', code: 'HT-1', name: '草稿', signDate: null, signedDate: null, status: 'DRAFT' }],
    milestones: [],
  };
  assert.equal(c8NoMilestone(input, contracts).length, 0);
});

test('履约偏差 · 基准日变化会改变逾期结论（证明 now 真的被注入而非读时钟）', () => {
  const input = fulfillmentFixture();
  const later = evaluateFulfillmentAnomalies({ ...input, now: new Date(2026, 11, 31) });
  const base = evaluateFulfillmentAnomalies(input);
  assert.ok(later.summary.byCode.C1_OVERDUE >= base.summary.byCode.C1_OVERDUE);
  // 基准日后移，K1 的验收节点逾期天数变大 → 从需复核变高风险
  const k1m3base = base.findings.find((f) => f.entityId === 'k1m3');
  const k1m3later = later.findings.find((f) => f.entityId === 'k1m3');
  assert.equal(k1m3base?.level, 'MEDIUM');
  assert.equal(k1m3later?.level, 'HIGH');
});
