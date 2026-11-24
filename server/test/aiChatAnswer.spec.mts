import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_SYSTEM_PROMPT,
  buildChatAnswer,
  buildChatAnswerMessages,
  chatFallbackAnswer,
} from '../src/modules/ai-insight/analytics/chat-answer.ts';
import { analyticsFactsToMarkdown, buildAnalyticsFacts } from '../src/modules/ai-insight/analytics/dataset-facts.ts';
import type { AiAnalyticsTotals, AiCollectedDataset } from '../src/modules/ai-core/dataset/analytics.types.ts';

/**
 * **AI 问数的措辞层与数字对账**（P3-A，纯函数）。
 *
 * 核心不变式：**数字只能来自事实清单，对不上就整段丢弃**。
 * 问答比报告更容易破这条——用户问一句话，模型很想「顺手算个合计」。所以这里把几类越界都钉住：
 * 自己加总、编造增长率、金额换算单位、答非所问时拿常识补。
 */

const totals = (over: Partial<AiAnalyticsTotals> = {}): AiAnalyticsTotals => ({
  projectCount: 2,
  contractCount: 3,
  signedYuan: 100000,
  settledYuan: 60000,
  paidYuan: 70000,
  invoicedYuan: 20000,
  unpaidYuan: -10000,
  uninvoicedYuan: 40000,
  overdueYuan: 0,
  costSavingsYuan: 0,
  assetInYuan: 0,
  financeCostYuan: 0,
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

const facts = () =>
  buildAnalyticsFacts({
    scopeLabel: '甲项目',
    scopeMode: 'current' as const,
    projects: [{ id: 'p1', code: 'P-1', name: '甲项目' }],
    period: { from: '2026-01-01', to: '2026-11-30', label: '2026-01-01 ~ 2026-11-30', preset: 'this_year' },
    compareMode: 'none' as const,
    comparePeriod: null,
    totals: totals(),
    compareTotals: null,
    byProject: [
      {
        projectId: 'p1',
        code: 'P-1',
        name: '甲项目',
        contractCount: 3,
        signedYuan: 100000,
        settledYuan: 60000,
        paidYuan: 70000,
        invoicedYuan: 20000,
        unpaidYuan: -10000,
        uninvoicedYuan: 40000,
        overdueYuan: 0,
        costSavingsYuan: 0,
        assetInYuan: 0,
        financeCostYuan: 0,
        dailyReports: 5,
        procurementTasks: 2,
      },
    ],
    datasets: [dataset('contract.detail', [{ 项目: '甲项目', 金额: 100000 }])],
    warnings: [],
    asOf: '2026-11-30',
    generatedAt: '2026-11-30T03:00:00.000Z',
  } as any);

describe('AI 问数 · 措辞与数字对账（纯函数）', () => {
  it('system prompt 写死了「不许计算 / 不许编造 / 不覆盖就说不掌握」和字数上限', () => {
    assert.match(CHAT_SYSTEM_PROMPT, /禁止任何计算|禁止任何计算/, '必须明写禁止计算');
    assert.match(CHAT_SYSTEM_PROMPT, /不许出现|一个都不许/, '必须明写不许出现清单外数字');
    assert.match(CHAT_SYSTEM_PROMPT, /系统当前数据不包含这个信息/, '不覆盖时必须明说，而不是拿常识补');
    assert.match(CHAT_SYSTEM_PROMPT, /200 字/, '必须有长度约束，否则问答会变成长报告');
    assert.match(CHAT_SYSTEM_PROMPT, /不要写标题|不要写表格/, '问答不该出标题/表格');
  });

  it('消息结构：system 口径 + user（范围/期间/事实清单/问题）', () => {
    const msgs = buildChatAnswerMessages({ facts: facts(), question: '甲项目签了多少合同？', scopeLabel: '甲项目', periodLabel: '2026 年' });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, CHAT_SYSTEM_PROMPT);
    assert.equal(msgs[1].role, 'user');
    assert.ok(msgs[1].content.includes('甲项目签了多少合同？'), '用户问题必须进 user 消息');
    assert.ok(msgs[1].content.includes('【事实清单】'), '必须带事实清单');
    assert.ok(msgs[1].content.includes('【统计期间】'), '必须带期间，否则模型不知道数字对应哪段时间');
  });

  it('答案里的数字都在事实清单里 → 采用', () => {
    const f = facts();
    // 从事实 Markdown 里挑一个真实存在的数字来复述
    const real = /100000|100,000/.exec(analyticsFactsToMarkdown(f));
    assert.ok(real, '事实清单里应出现签约额');
    const res = buildChatAnswer(f, '甲项目本年签约 100000 元，共 3 份合同。');
    assert.equal(res.accepted, true, `应被采用，实际丢弃了：${res.discarded.join(',')}`);
    assert.deepEqual(res.discarded, []);
    assert.ok(res.answer.includes('100000'));
  });

  it('模型自己加总出来的数字 → 整段丢弃，退回事实摘要并报出对不上的数字', () => {
    const f = facts();
    // 777777 是清单里绝不存在、模型自己算/编的数
    const res = buildChatAnswer(f, '甲项目本年签约 100000 元，合计回款 777777 元。');
    assert.equal(res.accepted, false);
    assert.ok(res.discarded.includes('777777'), `应对不上 777777，实际：${res.discarded.join(',')}`);
    assert.ok(res.answer.includes('无法对账'), '丢弃后必须告知用户为什么换了内容');
    assert.ok(res.answer.includes('事实汇总'), '丢弃后退回事实摘要');
    assert.ok(res.warnings.some((w) => w.includes('无法对账')));
  });

  it('用户问题里出现的数字放行（复述「那笔 500 万」不算编造）', () => {
    const f = facts();
    const res = buildChatAnswer(f, '你说的 5000000 那笔我没在清单里看到。', '5000000 那笔在哪？');
    assert.equal(res.accepted, true, `问题里的数字应被放行，实际丢弃：${res.discarded.join(',')}`);
  });

  it('空回答 → 退回事实摘要，不返回空串', () => {
    const f = facts();
    const res = buildChatAnswer(f, '   ');
    assert.equal(res.accepted, false);
    assert.ok(res.answer.includes('事实汇总') || res.answer.includes('模型没有给出可用回答'));
    assert.ok(res.answer.length > 100, '兜底不能是空内容');
  });

  it('剥掉模型自作主张的标题/表格/代码块行（问答不该出现这些）', () => {
    const f = facts();
    const raw = ['# 甲项目经营情况', '甲项目签约 100000 元。', '| 项目 | 金额 |', '```', '- 共 3 份合同'].join('\n');
    const res = buildChatAnswer(f, raw);
    assert.equal(res.accepted, true, `清洗后应可用，实际丢弃：${res.discarded.join(',')}`);
    assert.ok(!res.answer.includes('# 甲项目经营情况'), '标题行应被剥掉');
    assert.ok(!res.answer.includes('| 项目 |'), '表格行应被剥掉');
    assert.ok(res.answer.includes('- 共 3 份合同'), '列表要点应保留');
  });

  it('兜底文案 = 原因 + 事实清单（确定性、可核对）', () => {
    const f = facts();
    const text = chatFallbackAnswer(f, '出了点问题');
    assert.ok(text.includes('> 出了点问题'));
    assert.ok(text.includes(analyticsFactsToMarkdown(f)), '兜底必须带完整事实清单，用户能自己核');
  });
});
