import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalyticsWorkbookModel,
  sanitizeSheetName,
} from '../src/modules/ai/analytics/workbook-builder.ts';
import { buildAnalyticsFacts } from '../src/modules/ai/analytics/dataset-facts.ts';
import type { AiAnalyticsTotals, AiCollectedDataset } from '../src/modules/ai/analytics/analytics.types.ts';

const totals = (over: Partial<AiAnalyticsTotals> = {}): AiAnalyticsTotals => ({
  projectCount: 1,
  contractCount: 2,
  signedYuan: 100000,
  settledYuan: 60000,
  paidYuan: 40000,
  invoicedYuan: 20000,
  unpaidYuan: 20000,
  uninvoicedYuan: 40000,
  dailyReports: 3,
  procurementTasks: 1,
  ...over,
});

const dataset = (key: string, rows: Array<Record<string, string | number | null>>, truncated = false): AiCollectedDataset => ({
  key,
  columns: ['项目', '金额'],
  rows,
  totalRows: truncated ? 9000 : rows.length,
  truncated,
  summary: `共 ${rows.length} 行`,
});

const facts = () =>
  buildAnalyticsFacts({
    scopeLabel: '当前项目',
    projects: [{ id: 'p1', code: 'P-1', name: '甲项目' }],
    period: { from: '2026-01-01', to: '2026-11-12', label: '2026-01-01 ~ 2026-11-12', preset: 'this_year' },
    compareMode: 'mom',
    comparePeriod: { from: '2025-02-19', to: '2025-12-31', label: '2025-02-19 ~ 2025-12-31', mode: 'mom' },
    totals: totals(),
    compareTotals: totals({ signedYuan: 80000 }),
    byProject: [
      {
        projectId: 'p1', code: 'P-1', name: '甲项目', contractCount: 2, signedYuan: 100000, settledYuan: 60000,
        paidYuan: 40000, invoicedYuan: 20000, unpaidYuan: 20000, uninvoicedYuan: 40000, dailyReports: 3, procurementTasks: 1,
      },
    ],
    datasets: [
      dataset('contract.summary', [{ 项目: 'P-1 甲项目', 金额: 100000 }]),
      dataset('payment.records', [{ 项目: 'P-1 甲项目', 金额: 40000 }], true),
    ],
    warnings: ['示例提醒'],
    asOf: '2026-11-12',
    generatedAt: '2026-11-12T03:00:00.000Z',
  });

describe('AI 经营数据助手 · 工作簿模型', () => {
  it('sheet 名净化：非法字符替换、≤31 字符、重名加序号', () => {
    assert.equal(sanitizeSheetName('合同/结算:汇总*?[x]'), '合同_结算_汇总___x_');
    const long = sanitizeSheetName('很'.repeat(50));
    assert.ok(long.length <= 31);
    const used = new Set<string>();
    const a = sanitizeSheetName('总览', used);
    const b = sanitizeSheetName('总览', used);
    assert.equal(a, '总览');
    assert.equal(b, '总览 (2)');
  });

  it('工作表齐全：总览 / 项目对照 / 每个数据集 / 风险与提示', () => {
    const sheets = buildAnalyticsWorkbookModel(facts());
    const names = sheets.map((s) => s.name);
    assert.ok(names.includes('经营总览'));
    assert.ok(names.includes('项目对照'));
    assert.ok(names.includes('合同汇总'));
    assert.ok(names.includes('发票记录') === false, '未选中的数据集不出 sheet');
    assert.ok(names.includes('风险与提示'));
    assert.equal(new Set(names).size, names.length, 'sheet 名不得重复');
  });

  it('总览含本期/对比期列；项目对照按签约额排序；风险含等级', () => {
    const sheets = buildAnalyticsWorkbookModel(facts());
    const overview = sheets.find((s) => s.name === '经营总览')!;
    assert.deepEqual(overview.columns, ['指标', '本期', '对比期', '变化']);
    assert.ok(overview.rows.some((r) => r.指标 === '新签合同金额' && r.本期 === 100000 && r.对比期 === 80000));
    assert.ok(overview.note?.includes('合同链'));

    const risks = sheets.find((s) => s.name === '风险与提示')!;
    assert.ok(risks.rows.some((r) => r.类型 === '数据提醒' && r.内容 === '示例提醒'));
  });

  it('截断的数据集带说明，行数不超过模型给出的行', () => {
    const sheets = buildAnalyticsWorkbookModel(facts());
    const payments = sheets.find((s) => s.name === '付款记录')!;
    assert.ok(payments.note?.includes('共 9000 行'));
    assert.equal(payments.rows.length, 1);
  });
});
