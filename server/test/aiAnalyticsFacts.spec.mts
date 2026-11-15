import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyticsFactNumbers,
  analyticsFactsToMarkdown,
  analyticsTitle,
  buildAnalyticsFacts,
  buildNarratedReport,
  reportPresentation,
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
    scopeMode: 'all' as const,
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
    assert.ok(facts.dataGaps.some((w) => w.includes('发票记录')), '空数据集同时进 dataGaps');
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

  it('模型叙述：对账通过时按章节追加段落与建议，标题/表格被剥掉', () => {
    const facts = buildAnalyticsFacts(input());
    const res = buildNarratedReport(facts, {
      sections: {
        overview: '本期新签合同金额 100000 元，整体经营平稳。',
        contracts: '## 小标题\n| 仅供模型表格 | x |\n合同执行情况良好。',
        nope: '未知章节不该出现',
      },
      advice: ['关注付款进度与开票缺口'],
    });
    assert.equal(res.accepted, true);
    assert.deepEqual(res.discarded, []);
    assert.ok(res.markdown.includes('整体经营平稳'));
    assert.ok(res.markdown.includes('合同执行情况良好'));
    assert.ok(res.markdown.includes('、建议'));
    assert.ok(!res.markdown.includes('未知章节不该出现'));
    assert.ok(!res.markdown.includes('## 小标题'), '模型写的标题会被剥掉');
    assert.ok(!res.markdown.includes('仅供模型表格'), '模型写的表格会被剥掉');
    assert.ok(res.markdown.includes('### 合同汇总'), '程序表格仍是主体');
  });

  it('模型叙述编数字：整段丢弃并返回 discarded，报告退回确定性版本', () => {
    const facts = buildAnalyticsFacts(input());
    const res = buildNarratedReport(facts, {
      sections: { overview: '本期金额 123456789 元，同比大增。' },
      advice: [],
    });
    assert.equal(res.accepted, false);
    assert.ok(res.discarded.length > 0, '无法对账的数字要能列出来');
    assert.ok(!res.markdown.includes('123456789'), '丢弃的段落不得进入报告');
    assert.ok(res.markdown.includes('## 一、经营总览'), '仍返回确定性报告');
    assert.ok(res.warnings.some((w) => w.includes('丢弃')));
  });

  it('模型返回空/非对象：不空窗，直接输出确定性报告', () => {
    const facts = buildAnalyticsFacts(input());
    for (const raw of [null, 'text', { sections: {}, advice: [] }, { sections: { nope: 'x' } }]) {
      const res = buildNarratedReport(facts, raw);
      assert.equal(res.accepted, false);
      assert.ok(res.markdown.includes('## 一、经营总览'));
      assert.ok(res.warnings.length > 0);
    }
  });

  it('备注（notes）里的数字放行；不放行时该数字被判编造', () => {
    const facts = buildAnalyticsFacts(input());
    const ok = buildNarratedReport(
      facts,
      { sections: { overview: '按备注 12345 元口径执行。' } },
      '备注：12345 元',
    );
    assert.equal(ok.accepted, true);
    const bad = buildNarratedReport(facts, { sections: { overview: '按备注 12345 元口径执行。' } });
    assert.equal(bad.accepted, false);
    assert.ok(bad.discarded.some((d) => d.includes('12345')));
  });

  it('reportKind 决定章节顺序；detail=summary 不铺数据集表格', () => {
    const facts = buildAnalyticsFacts({
      ...input(),
      datasets: [
        dataset('contract.summary', [{ 项目: 'P-1 甲项目', 金额: 80000 }]),
        dataset('contract.fulfillment', [{ 项目: 'P-1 甲项目', 金额: 1 }]),
      ],
    });
    const projectMd = analyticsFactsToMarkdown(
      facts,
      reportPresentation({ reportKind: 'project', detail: 'both', focus: [] }),
    );
    assert.ok(projectMd.indexOf('履约进度') < projectMd.indexOf('合同情况'), 'project 简报应把履约提前');

    const summaryMd = analyticsFactsToMarkdown(
      facts,
      reportPresentation({ reportKind: 'custom', detail: 'summary', focus: [] }),
    );
    assert.ok(summaryMd.includes('- 示例汇总'), '摘要行保留');
    assert.ok(!summaryMd.includes('| 项目 | 金额 |'), 'summary 不铺数据集表格');
  });

  it('focus 影响风险排序与报告头部', () => {
    const facts = buildAnalyticsFacts(input());
    const md = analyticsFactsToMarkdown(
      facts,
      reportPresentation({ reportKind: 'custom', detail: 'both', focus: ['invoice_gap'] }),
    );
    assert.ok(md.includes('关注点：开票缺口'));
    assert.ok(md.indexOf('开票落后于结算') < md.indexOf('付款超过结算'), '关注的发票风险应排在前面');
  });

  it('项目超过 20 个时补「其余 N 个项目合计」行', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      projectId: `p${i}`,
      code: `P-${i}`,
      name: `项目${i}`,
      contractCount: 1,
      signedYuan: 1000 + i,
      settledYuan: 0,
      paidYuan: 0,
      invoicedYuan: 0,
      unpaidYuan: 0,
      uninvoicedYuan: 0,
      dailyReports: 0,
      procurementTasks: 0,
    }));
    const facts = buildAnalyticsFacts({ ...input(), byProject: many });
    const md = analyticsFactsToMarkdown(facts);
    assert.ok(md.includes('其余 1 个项目合计'));
  });
});
