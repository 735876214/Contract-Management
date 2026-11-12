import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyticsFactNumbers,
  analyticsFactsToMarkdown,
  analyticsTitle,
  buildAnalyticsFacts,
} from '../src/modules/ai/analytics/dataset-facts.ts';
import type {
  AiAnalyticsTotals,
  AiCollectedDataset,
} from '../src/modules/ai/analytics/analytics.types.ts';

const totals = (over: Partial<AiAnalyticsTotals> = {}): AiAnalyticsTotals => ({
  projectCount: 2,
  contractCount: 3,
  signedYuan: 100000,
  settledYuan: 60000,
  paidYuan: 70000,
  invoicedYuan: 20000,
  unpaidYuan: -10000,
  uninvoicedYuan: 40000,
  dailyReports: 5,
  procurementTasks: 2,
  ...over,
});

const dataset = (key: string, rows: Array<Record<string, string | number | null>>): AiCollectedDataset => ({
  key,
  columns: ['项目', '金额'],
  rows,
  totalRows: rows.length,
  truncated: false,
  summary: `示例汇总 ${rows.length} 行`,
});

/**
 * 经营数据助手 · 事实包与确定性报告（纯函数）：
 * 口径提示随包而出（合同链/业务发生日/发票两态/未填 ≠ 0），风险由程序判定，
 * Markdown 只写事实包里的数字，数据集空档要显式说明（不是 0）。
 */
describe('AI 经营数据助手 · 事实包与报告', () => {
  const input = () => ({
    scopeLabel: '全部项目（2 个）',
    projects: [
      { id: 'p1', code: 'P-1', name: '甲项目' },
      { id: 'p2', code: 'P-2', name: '乙项目' },
    ],
    period: { from: '2026-01-01', to: '2026-11-12', label: '2026-01-01 ~ 2026-11-12', preset: 'this_year' },
    compareMode: 'mom' as const,
    comparePeriod: { from: '2025-02-19', to: '2025-12-31', label: '2025-02-19 ~ 2025-12-31', mode: 'mom' as const },
    totals: totals(),
    compareTotals: totals({ signedYuan: 200000, settledYuan: 60000, paidYuan: 60000 }),
    byProject: [
      {
        projectId: 'p1', code: 'P-1', name: '甲项目', contractCount: 2, signedYuan: 80000, settledYuan: 50000,
        paidYuan: 60000, invoicedYuan: 20000, unpaidYuan: -10000, uninvoicedYuan: 30000, dailyReports: 3, procurementTasks: 1,
      },
      {
        projectId: 'p2', code: 'P-2', name: '乙项目', contractCount: 1, signedYuan: 20000, settledYuan: 10000,
        paidYuan: 10000, invoicedYuan: 0, unpaidYuan: 0, uninvoicedYuan: 10000, dailyReports: 2, procurementTasks: 1,
      },
    ],
    datasets: [
      dataset('contract.summary', [{ 项目: 'P-1 甲项目', 金额: 80000 }]),
      dataset('invoice.records', []),
    ],
    warnings: [],
    asOf: '2026-11-12',
    generatedAt: '2026-11-12T03:00:00.000Z',
  });

  it('补注册表元信息；空数据集进 warnings；风险由程序判定', () => {
    const facts = buildAnalyticsFacts(input());
    assert.equal(facts.datasets.length, 2);
    assert.equal(facts.datasets[0].label, '合同汇总');
    assert.equal(facts.datasets[0].section, 'contracts');
    assert.equal(facts.datasets[1].empty, true);
    assert.ok(facts.warnings.some((w) => w.includes('发票记录')));
    const codes = facts.risks.map((r) => r.code);
    assert.ok(codes.includes('OVERPAID'), '付款超过结算应报高风险');
    assert.ok(codes.includes('INVOICE_GAP'), '开票缺口 ≥20 个百分点应报中风险');
    assert.ok(codes.includes('COMPARE_DROP'), '新签金额环比 −50% 应报中风险');
    assert.equal(facts.risks.find((r) => r.code === 'OVERPAID')!.level, 'RED');
  });

  it('确定性 Markdown：口径说明、总览对比、项目对照、数据集小节、风险', () => {
    const md = analyticsFactsToMarkdown(buildAnalyticsFacts(input()));
    assert.ok(md.includes('# 全部项目（2 个） · 2026-01-01 ~ 2026-11-12'));
    assert.ok(md.includes('合同金额按合同链'));
    assert.ok(md.includes('发票排除作废与红冲'));
    assert.ok(md.includes('## 一、经营总览'));
    assert.ok(md.includes('## 二、项目对照'));
    assert.ok(md.includes('P-1 甲项目'));
    assert.ok(md.includes('### 合同汇总'));
    assert.ok(md.includes('未取到数据（数据缺口，不是 0）'));
    assert.ok(md.includes('【高】'));
    assert.ok(md.includes('【中】'));
  });

  it('事实数字：总览、项目与风险文案里的数字都放行（供对账）', () => {
    const nums = analyticsFactNumbers(buildAnalyticsFacts(input()));
    for (const n of [100000, 60000, 70000, 20000, 80000, 3, 5]) {
      assert.ok(nums.includes(n), `应放行数字 ${n}`);
    }
    assert.ok(nums.includes(10000), '风险文案里的差额绝对值也应放行');
  });

  it('标题：范围 + 期间 + 类型，且不超过 60 字', () => {
    const t = analyticsTitle('brief', '全部项目（3 个）', '2026-01-01 ~ 2026-11-12');
    assert.ok(t.includes('全部项目') && t.includes('领导简报'));
    assert.ok(t.length <= 60);
  });

  it('无对比期时 Markdown 只显示本期列，不写「变化」列', () => {
    const facts = buildAnalyticsFacts({ ...input(), compareMode: 'none' as const, comparePeriod: null, compareTotals: null });
    const md = analyticsFactsToMarkdown(facts);
    assert.ok(md.includes('| 指标 | 本期 |'));
    assert.ok(!md.includes('| 指标 | 本期 | 对比期 | 变化 |'));
  });
});
