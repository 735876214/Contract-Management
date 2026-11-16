import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePaymentAnomalies } from '../src/modules/ai/anomaly/rules-payment.ts';
import {
  buildSyntheticDataset,
  datasetStats,
  scoreFindings,
  scoreToMarkdown,
  mulberry32,
} from '../src/modules/ai/anomaly/anomaly-bench.ts';

const dataset = buildSyntheticDataset();
const evaluation = evaluatePaymentAnomalies(dataset.input);
const score = scoreFindings(evaluation.findings, dataset.truth);

test('合成夹具：同 seed 完全可复现（评测结论必须能被别人复算）', () => {
  const again = buildSyntheticDataset();
  assert.equal(JSON.stringify(again.input), JSON.stringify(dataset.input));
  assert.equal(JSON.stringify(again.truth), JSON.stringify(dataset.truth));
});

test('合成夹具：换 seed 只影响随机成分，规模与真值条数不变', () => {
  const other = buildSyntheticDataset({ seed: 7 });
  assert.notEqual(JSON.stringify(other.input.payments), JSON.stringify(dataset.input.payments));
  assert.equal(other.truth.length, dataset.truth.length);
  assert.deepEqual(other.meta.codes, dataset.meta.codes);
});

test('PRNG 分布健全：mulberry32 落在 [0,1) 且不退化', () => {
  const rnd = mulberry32(42);
  const xs = Array.from({ length: 2000 }, () => rnd());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.min(...xs) < 0.05 && Math.max(...xs) > 0.95);
});

test('数据集规模与注入条数符合设计', () => {
  const stats = datasetStats(dataset);
  assert.equal(stats['合同'], 12);
  assert.equal(stats['结算单'], 12 * 5 + 1); // 12 份各 5 期，合同 1 多一张重复单
  assert.equal(stats['注入异常'], 9); // 8 个规则码，R3 注入 2 条
  assert.equal(dataset.meta.injected, 9);
});

test('8 个规则码全部覆盖（评测集不得漏掉任何一条规则）', () => {
  assert.deepEqual(dataset.meta.codes, [
    'R1_DUP_ACROSS_PERIOD',
    'R1_DUP_MATERIAL_QTY',
    'R1_FINAL_SNAPSHOT_DRIFT',
    'R2_OVERPAY',
    'R3_PAY_WITHOUT_CONTRACT',
    'R4_INVOICE_MISMATCH',
    'R5_SETTLE_BEFORE_RECEIPT',
    'R6_PROCEDURE_SNAPSHOT_DRIFT',
  ]);
});

test('规则层在评测集上：召回 100%、零误报', () => {
  assert.equal(score.missed, 0, `有漏报：${JSON.stringify(score.missedSamples, null, 2)}`);
  assert.equal(
    score.falsePositives,
    0,
    `有误报：${JSON.stringify(
      score.falsePositiveSamples.map((f) => ({ code: f.code, entityId: f.entityId, title: f.title })),
      null,
      2,
    )}`,
  );
  assert.equal(score.recall, 1);
  assert.equal(score.caught, dataset.truth.length);
});

test('干净合同（c09～c12）零命中，且规则没有"未判定"缺口', () => {
  const clean = new Set(['c09', 'c10', 'c11', 'c12']);
  const onClean = evaluation.findings.filter((f) => [...clean].some((id) => f.entityId.startsWith(id)));
  assert.deepEqual(onClean, []);
  assert.deepEqual(evaluation.notEvaluated, []);
});

test('评分器自身可校准：删一条真值→漏报，多一条假真值→误报', () => {
  const dropped = scoreFindings(evaluation.findings, dataset.truth.slice(1));
  assert.equal(dropped.falsePositives, 1, '少登记一条真值，对应命中必须被算成误报');

  const padded = [
    ...dataset.truth,
    { code: 'R2_OVERPAY' as const, entityId: 'c99', contractId: 'c99', note: '不存在的注入' },
  ];
  const missed = scoreFindings(evaluation.findings, padded);
  assert.equal(missed.missed, 1);
  assert.ok(missed.recall < 1);
});

test('评分可按规则码分列，且召回口径为 caught/injected', () => {
  for (const row of score.byCode) {
    assert.equal(row.recall, row.injected === 0 ? 0 : row.caught / row.injected);
    assert.equal(row.missed, row.injected - row.caught);
  }
  assert.equal(score.byCode.reduce((s, c) => s + c.injected, 0), dataset.truth.length);
});

test('评测结果可渲染成 Markdown（报告里直接引用）', () => {
  const md = scoreToMarkdown(score);
  assert.match(md, /召回率 \*\*100\.0%\*\*/);
  assert.match(md, /\| R2_OVERPAY \| 1 \| 1 \| 0 \| 0 \| 100\.0% \|/);
});

test('同一输入重复评测结果稳定（无隐藏状态）', () => {
  const again = evaluatePaymentAnomalies(dataset.input);
  assert.equal(JSON.stringify(again.findings), JSON.stringify(evaluation.findings));
});

test('规模护栏：2 000 张结算单判定 < 2 s（防未来把规则改成 O(n³)）', () => {
  const big = buildSyntheticDataset({ contracts: 400 });
  const t0 = process.hrtime.bigint();
  const r = evaluatePaymentAnomalies(big.input);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(r.findings.length >= 9, '违规规模下规则仍应跑出结果');
  assert.ok(ms < 2000, `判定耗时 ${ms.toFixed(1)}ms 超出护栏`);
});
