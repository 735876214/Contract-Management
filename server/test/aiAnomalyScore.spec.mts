import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codeLabel,
  findingKey,
  gateStatus,
  parseTruth,
  scoreFindings,
  scoreToMarkdown,
  type TruthFile,
} from '../src/modules/ai/anomaly/anomaly-score.ts';

/**
 * 评分层单测。
 * 这一层决定"评测报告能不能信"：
 * 真值解析太松 → 标了没生效会被算成漏报；评分口径错 → 报告数字与人工标注对不上。
 * 所以这里对**严格性**与**误差方向**都有断言。
 */

const truth = (annotations: Array<[string, string, boolean]>): TruthFile => ({
  projectId: 'proj-1',
  annotations: annotations.map(([code, entityId, hit]) => ({ code, entityId, hit })),
});

test('真值解析：合法文件规整后保留可选字段，未填 note 归一为 undefined', () => {
  const parsed = parseTruth({
    projectId: 'proj-1',
    annotatedBy: '张三',
    annotations: [{ code: 'R2_OVERPAY', entityId: 'C1', hit: true, note: ' 合同 1 累计付款已超 80% 上限 ' }],
  });
  assert.equal(parsed.projectId, 'proj-1');
  assert.equal(parsed.annotatedBy, '张三');
  assert.equal(parsed.annotations.length, 1);
  assert.equal(parsed.annotations[0].note, '合同 1 累计付款已超 80% 上限');
  assert.deepEqual(parseTruth({ annotations: [{ code: 'R2_OVERPAY', entityId: 'C1', hit: false }] }).annotations[0], {
    code: 'R2_OVERPAY',
    entityId: 'C1',
    hit: false,
    note: undefined,
  });
});

test('真值解析：结构错误必须带位置炸掉（否则"标了没生效"会伪装成规则漏报）', () => {
  assert.throws(() => parseTruth(null), /顶层必须是对象/);
  assert.throws(() => parseTruth({}), /缺少 annotations 数组/);
  assert.throws(() => parseTruth({ annotations: [null] }), /annotations\[0\] 不是对象/);
  assert.throws(() => parseTruth({ annotations: [{ code: '', entityId: 'C1', hit: true }] }), /annotations\[0\]\.code 为空/);
  assert.throws(() => parseTruth({ annotations: [{ code: 'R2', entityId: '', hit: true }] }), /annotations\[0\]\.entityId 为空/);
  assert.throws(() => parseTruth({ annotations: [{ code: 'R2', entityId: 'C1', hit: 'yes' }] }), /hit 必须是 true\/false/);
  assert.throws(
    () =>
      parseTruth({
        annotations: [
          { code: 'R2', entityId: 'C1', hit: true },
          { code: 'R2', entityId: 'C1', hit: false },
        ],
      }),
    /重复标注：R2#C1/,
  );
});

test('评分：完美命中时召回与查准都是 100%，门槛通过', () => {
  const t = truth([
    ['R2_OVERPAY', 'C1', true],
    ['R3_PAY_WITHOUT_CONTRACT', 'P9', true],
  ]);
  const report = scoreFindings([{ code: 'R2_OVERPAY', entityId: 'C1' }, { code: 'R3_PAY_WITHOUT_CONTRACT', entityId: 'P9' }], t);
  assert.equal(report.tp, 2);
  assert.equal(report.fp, 0);
  assert.equal(report.fn, 0);
  assert.equal(report.recall, 1);
  assert.equal(report.precision, 1);
  assert.equal(report.missed.length, 0);
  assert.deepEqual(gateStatus(report, { minRecall: 0.9, maxFp: 2 }).passed, true);
});

test('评分：漏报进 missed 且召回按"真值该报"为分母（被少报不会抬分）', () => {
  const t = truth([
    ['R2_OVERPAY', 'C1', true],
    ['R2_OVERPAY', 'C2', true],
    ['R4_INVOICE_MISMATCH', 'S3', true],
    ['R5_SETTLE_BEFORE_RECEIPT', 'S4', true],
  ]);
  const report = scoreFindings([{ code: 'R2_OVERPAY', entityId: 'C1' }], t);
  assert.equal(report.tp, 1);
  assert.equal(report.fn, 3);
  assert.equal(report.recall, 0.25);
  assert.deepEqual(
    report.missed.map((m) => findingKey(m.code, m.entityId)),
    ['R2_OVERPAY#C2', 'R4_INVOICE_MISMATCH#S3', 'R5_SETTLE_BEFORE_RECEIPT#S4'],
  );
});

test('评分：误报区分"人工判定不该报"与"真值未标注"，两者都计入 fp', () => {
  const t = truth([
    ['R2_OVERPAY', 'C1', true],
    ['R1_DUP_ACROSS_PERIOD', 'S7', false],
  ]);
  const report = scoreFindings(
    [
      { code: 'R2_OVERPAY', entityId: 'C1' },
      { code: 'R1_DUP_ACROSS_PERIOD', entityId: 'S7' },
      { code: 'R1_DUP_ACROSS_PERIOD', entityId: 'S8' },
    ],
    t,
  );
  assert.equal(report.tp, 1);
  assert.equal(report.fp, 2);
  assert.equal(report.precision, 1 / 3);
  const reasons = new Map(report.unexpected.map((u) => [findingKey(u.code, u.entityId), u.reason]));
  assert.equal(reasons.get('R1_DUP_ACROSS_PERIOD#S7'), 'annotated_false');
  assert.equal(reasons.get('R1_DUP_ACROSS_PERIOD#S8'), 'unannotated');
});

test('评分：按规则拆开看——合计好看但单条规则崩掉必须能被看见', () => {
  const t = truth([
    ['R1_DUP_ACROSS_PERIOD', 'S1', true],
    ['R1_DUP_ACROSS_PERIOD', 'S2', true],
    ['R6_PROCEDURE_SNAPSHOT_DRIFT', 'PR1', true],
    ['R6_PROCEDURE_SNAPSHOT_DRIFT', 'PR2', true],
  ]);
  const report = scoreFindings(
    [
      { code: 'R1_DUP_ACROSS_PERIOD', entityId: 'S1' },
      { code: 'R1_DUP_ACROSS_PERIOD', entityId: 'S2' },
      { code: 'R6_PROCEDURE_SNAPSHOT_DRIFT', entityId: 'PR1' },
    ],
    t,
  );
  assert.equal(report.recall, 0.75);
  const byCode = new Map(report.byCode.map((c) => [c.code, c]));
  assert.equal(byCode.get('R1_DUP_ACROSS_PERIOD')!.recall, 1);
  assert.equal(byCode.get('R6_PROCEDURE_SNAPSHOT_DRIFT')!.recall, 0.5);
  assert.equal(byCode.get('R6_PROCEDURE_SNAPSHOT_DRIFT')!.fn, 1);
  assert.deepEqual(
    report.byCode.map((c) => c.code),
    ['R1_DUP_ACROSS_PERIOD', 'R6_PROCEDURE_SNAPSHOT_DRIFT'],
  );
});

test('评分：重复预测只算一次（去重按 code+entityId）', () => {
  const t = truth([['R2_OVERPAY', 'C1', true]]);
  const report = scoreFindings(
    [
      { code: 'R2_OVERPAY', entityId: 'C1' },
      { code: 'R2_OVERPAY', entityId: 'C1' },
    ],
    t,
  );
  assert.equal(report.predicted, 1);
  assert.equal(report.tp, 1);
  assert.equal(report.fp, 0);
});

test('门槛：召回不足或误报超限都要拦，且理由写清数字', () => {
  const report = scoreFindings([{ code: 'R2_OVERPAY', entityId: 'C1' }], truth([['R2_OVERPAY', 'C1', true], ['R2_OVERPAY', 'C2', true]]));
  const gate = gateStatus(report, { minRecall: 0.9, maxFp: 0 });
  assert.equal(gate.passed, false);
  assert.ok(gate.reasons.some((r) => r.includes('召回率 50.0% < 门槛 90.0%')));

  const noisy = scoreFindings(
    [
      { code: 'R2_OVERPAY', entityId: 'C1' },
      { code: 'R2_OVERPAY', entityId: 'C2' },
      { code: 'R2_OVERPAY', entityId: 'C3' },
    ],
    truth([['R2_OVERPAY', 'C1', true]]),
  );
  const noisyGate = gateStatus(noisy, { minRecall: 0.9, maxFp: 1 });
  assert.equal(noisyGate.passed, false);
  assert.ok(noisyGate.reasons.some((r) => r.includes('误报 2 条 > 门槛 1 条')));
});

test('门槛：真值没有 hit=true 时不给出"召回 0%"的假结论，而是明确拒绝判定', () => {
  const report = scoreFindings([], truth([['R2_OVERPAY', 'C1', false]]));
  assert.equal(report.recall, null);
  assert.equal(report.precision, null);
  const gate = gateStatus(report, {});
  assert.equal(gate.passed, false);
  assert.ok(gate.reasons.some((r) => r.includes('无法计算召回率')));
});

test('报告渲染：含总体/按规则/漏报/误报四段，空清单写"无。"而不是空表', () => {
  const clean = scoreFindings([{ code: 'R2_OVERPAY', entityId: 'C1' }], truth([['R2_OVERPAY', 'C1', true]]));
  const md = scoreToMarkdown(clean, {
    datasetNote: '项目 proj-1（导出时间 2026-10-23）',
    annotatedBy: '张三',
    datasetSize: { 合同: 3, 结算单: 4 },
    minRecall: 0.9,
    maxFp: 2,
  });
  assert.ok(md.includes('## 总体'));
  assert.ok(md.includes('## 按规则'));
  assert.ok(md.includes('## 漏报清单'));
  assert.ok(md.includes('## 误报清单'));
  assert.ok(md.includes('| 召回率 | 100.0% |'));
  assert.ok(md.includes('项目 proj-1（导出时间 2026-10-23）'));
  assert.ok(md.includes('样本量：合同 3 / 结算单 4'));
  assert.ok(md.includes('**通过**'));
  assert.equal(md.split('无。').length - 1, 2, '漏报与误报都为空时应各写一处"无。"');

  const dirty = scoreFindings([{ code: 'R1_DUP_ACROSS_PERIOD', entityId: 'S8' }], truth([['R2_OVERPAY', 'C1', true], ['R1_DUP_ACROSS_PERIOD', 'S8', false]]));
  const dirtyMd = scoreToMarkdown(dirty, { minRecall: 0.9, maxFp: 0 });
  assert.ok(dirtyMd.includes('**不通过**'));
  assert.ok(dirtyMd.includes('R2 超付')); // 漏报清单里用的是中文规则名
  assert.ok(dirtyMd.includes('人工判定不应报'));
});

test('规则名映射：未知规则码原样返回（新规则忘了登记也不至于显示 undefined）', () => {
  assert.equal(codeLabel('R2_OVERPAY'), 'R2 超付');
  assert.equal(codeLabel('R9_UNKNOWN'), 'R9_UNKNOWN');
});
