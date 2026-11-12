import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelIntent, parseIntentRules } from '../src/modules/ai/intent/intent-rules.ts';

/**
 * 规则意图解析（Phase 1 唯一路径）：只输出枚举与注册表 key，不产出 ID/日期/数字；
 * 前端结构化选择逐字段覆盖文本解析，`datasets` 非空整体替换。
 */
describe('AI 经营数据助手 · 规则意图', () => {
  it('「汇总全部项目今年合同、结算、付款和发票，出一份给领导的简报」', () => {
    const { intent, warnings } = parseIntentRules({
      text: '汇总全部项目今年合同、结算、付款和发票，出一份给领导的简报',
    });
    assert.equal(intent.scope.mode, 'all');
    assert.equal(intent.period.preset, 'this_year');
    assert.equal(intent.reportKind, 'brief');
    assert.equal(intent.compare, 'mom');
    assert.deepEqual(warnings, []);
    for (const key of ['contract.summary', 'settlement.summary', 'payment.records', 'invoice.records']) {
      assert.ok(intent.datasets.includes(key), `应选中 ${key}`);
    }
  });

  it('同比/环比：关键词单选，累计至今归一为 none', () => {
    assert.equal(parseIntentRules({ text: '今年合同同比情况' }).intent.compare, 'yoy');
    assert.equal(parseIntentRules({ text: '本月付款环比' }).intent.compare, 'mom');
    assert.equal(parseIntentRules({ text: '累计至今全部结算' }).intent.period.preset, 'all');
    assert.equal(parseIntentRules({ text: '累计至今全部结算' }).intent.compare, 'none');
  });

  it('显式数据集整体替换文本命中（不做并集）', () => {
    const { intent } = parseIntentRules({
      text: '合同结算付款发票',
      datasets: ['invoice.records'],
    });
    assert.deepEqual(intent.datasets, ['invoice.records']);
  });

  it('显式 period/scope/compare/reportKind 逐字段覆盖文本', () => {
    const { intent } = parseIntentRules({
      text: '全部项目去年简报',
      scope: { mode: 'current' },
      period: { preset: 'custom', from: '2026-01-01', to: '2026-06-30' },
      compare: 'yoy',
      reportKind: 'monthly',
    });
    assert.equal(intent.scope.mode, 'current');
    assert.equal(intent.period.preset, 'custom');
    assert.equal(intent.period.from, '2026-01-01');
    assert.equal(intent.compare, 'yoy');
    assert.equal(intent.reportKind, 'monthly');
  });

  it('未知数据集/关注点/范围：丢弃并进 warnings，不选错', () => {
    const { intent, unknownDatasets, warnings } = parseIntentRules({
      datasets: ['contract.summary', 'nope.unknown'],
      focus: ['payment_risk', 'nope_focus'],
      scope: { mode: 'galaxy' },
    });
    assert.deepEqual(intent.datasets, ['contract.summary']);
    assert.deepEqual(unknownDatasets, ['nope.unknown']);
    assert.ok(warnings.some((w) => w.includes('nope.unknown')));
    assert.ok(warnings.some((w) => w.includes('nope_focus')));
    assert.ok(warnings.some((w) => w.includes('galaxy')));
    assert.deepEqual(intent.focus, ['payment_risk']);
  });

  it('自定义期间缺日期：回落本月并提示', () => {
    const { intent, warnings } = parseIntentRules({ period: { preset: 'custom', from: '2026-01-01' } });
    assert.equal(intent.period.preset, 'this_month');
    assert.ok(warnings.some((w) => w.includes('自定义期间')));
  });

  it('数据集最多 8 个：超出的截断并提示', () => {
    const keys = [
      'contract.summary',
      'contract.detail',
      'settlement.summary',
      'settlement.detail',
      'payment.records',
      'invoice.records',
      'cost.profit_loss',
      'daily.report',
      'asset.flow',
    ];
    const { intent, warnings } = parseIntentRules({ datasets: keys });
    assert.equal(intent.datasets.length, 8);
    assert.ok(warnings.some((w) => w.includes('截断')));
  });

  it('输出形态：默认只出报告；提到表格才带工作簿', () => {
    assert.deepEqual(parseIntentRules({ text: '本月合同汇总' }).intent.outputs, { report: true, workbook: false });
    assert.deepEqual(parseIntentRules({ text: '本月合同汇总并导出表格' }).intent.outputs, {
      report: true,
      workbook: true,
    });
  });

  it('文本与 notes 截断：rawText ≤2000、notes ≤300', () => {
    const long = '合'.repeat(3000);
    const { intent } = parseIntentRules({ text: long, notes: '注'.repeat(500) });
    assert.equal(intent.rawText?.length, 2000);
    assert.equal(intent.notes?.length, 300);
  });

  it('模型补丁只认白名单：ID/日期/金额/未知枚举一律忽略', () => {
    const { patch } = normalizeModelIntent({
      scope: { mode: 'all', mentions: ['甲项目', '  '], projectId: 'p-ID-123' },
      period: { preset: 'this_year', from: '2020-01-01', to: '2020-12-31' },
      compare: 'yoy',
      datasets: ['contract.summary', 'nope.key', 'contract.summary'],
      focus: ['payment_risk', 'nope'],
      reportKind: 'brief',
      detail: 'both',
      groupBy: 'month',
      outputs: { report: true, workbook: true },
      amount: 999999,
      from: '2020-01-01',
    });
    assert.equal(patch.scopeMode, 'all');
    assert.deepEqual(patch.mentions, ['甲项目']);
    assert.equal(patch.periodPreset, 'this_year');
    assert.equal(patch.compare, 'yoy');
    assert.deepEqual(patch.datasets, ['contract.summary']);
    assert.deepEqual(patch.focus, ['payment_risk']);
    assert.equal(patch.reportKind, 'brief');
    assert.equal(patch.detail, 'both');
    assert.equal(patch.groupBy, 'month');
    assert.deepEqual(patch.outputs, { report: true, workbook: true });
    assert.ok(!('amount' in patch), '模型给出的金额不进补丁');
    assert.ok(!('from' in patch) && !('to' in patch), '模型给出的日期不进补丁');
  });

  it('合并顺序：文本 < 模型补丁 < 前端显式选择', () => {
    const model = {
      scopeMode: 'all' as const,
      compare: 'yoy' as const,
      datasets: ['invoice.records'],
      reportKind: 'brief' as const,
    };
    const fromModel = parseIntentRules({ text: '本月合同汇总' }, model);
    assert.equal(fromModel.intent.scope.mode, 'all');
    assert.equal(fromModel.intent.compare, 'yoy');
    assert.deepEqual(fromModel.intent.datasets, ['invoice.records']);
    assert.equal(fromModel.intent.reportKind, 'brief');

    const explicit = parseIntentRules(
      { text: '本月合同汇总', scope: { mode: 'current' }, datasets: ['contract.summary'] },
      model,
    );
    assert.equal(explicit.intent.scope.mode, 'current', '前端显式范围压过模型');
    assert.deepEqual(explicit.intent.datasets, ['contract.summary'], '前端显式数据集整体替换模型结果');
    assert.equal(explicit.intent.reportKind, 'brief', '未被前端覆盖的字段沿用模型');
  });
});
