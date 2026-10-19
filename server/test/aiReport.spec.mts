import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_KINDS,
  auditReport,
  factNumbers,
  factsToMarkdown,
  markdownToHtml,
  type ReportFacts,
} from '../src/modules/ai/report-facts.ts';

/**
 * 汇报材料的事实包与产出对账。
 *
 * 底线：**材料里的数字必须能在事实清单里找到**。
 * 模型为了让句子顺会编「同比增长 15%」，`auditReport` 就是专门抓这个的——
 * 这条用例必须能失败，否则等于没写。
 */

const facts: ReportFacts = {
  project: { name: '紫金街雨污分流工程', code: 'ZJX-01', manager: '张工', startDate: '2026-01-01', endDate: '2026-12-31', selfContractAmount: 1200 },
  period: { from: '2026-08-01', to: '2026-08-31', label: '2026-08-01 ~ 2026-08-31' },
  contracts: { total: 12, executing: 5, signedInPeriod: 2, signedAmountInPeriod: 36476.97, totalAmount: 980000 },
  settlement: { countInPeriod: 3, amountInPeriod: 150000, totalAmount: 600000 },
  payment: { countInPeriod: 2, amountInPeriod: 120000, totalAmount: 500000, unpaid: 100000 },
  invoice: { countInPeriod: 1, amountInPeriod: 80000, totalAmount: 450000 },
  daily: { reportsInPeriod: 26 },
  risks: ['存在应付未付 100000.00 元，需关注付款进度'],
};

describe('factsToMarkdown：事实清单要能直接抄', () => {
  const md = factsToMarkdown(facts);

  it('把关键金额与计数都列出来', () => {
    assert.ok(md.includes('36476.97'));
    assert.ok(md.includes('980000.00'));
    assert.ok(md.includes('100000.00'));
    assert.ok(md.includes('合同总数：12 份'));
    assert.ok(md.includes('区间内日报：26 条'));
  });

  it('包含项目标识与统计区间，便于模型起标题', () => {
    assert.ok(md.includes('紫金街雨污分流工程'));
    assert.ok(md.includes('2026-08-01 ~ 2026-08-31'));
  });

  it('风险点原样带出；没有风险时给明确说明而不是留空', () => {
    assert.ok(md.includes('存在应付未付'));
    const empty = factsToMarkdown({ ...facts, risks: [] });
    assert.ok(empty.includes('暂无系统识别的风险点'));
  });

  it('自营合同额同时给出万元原值与折算后的人民币', () => {
    assert.ok(md.includes('1200.00 万元'));
    const nums = factNumbers(facts);
    assert.ok(nums.includes(1200));
    assert.ok(nums.includes(12000000));
  });
});

describe('auditReport：材料里的数字必须来自系统数据', () => {
  it('引用事实清单里的数字不报案', () => {
    const md = '## 一、经营概况\n本月新签 2 份合同，金额 36476.97 元；累计已付款 500000.00 元。';
    const r = auditReport(md, facts);
    assert.deepEqual(r.unknown, []);
    // 「2 份」这类带量词的是计数，按规则不参与对账，只核金额
    assert.ok(r.checked >= 2);
  });

  it('编造的数字必须被抓出来（这是本模块存在的理由）', () => {
    const md = '本月新签 4 份合同，同比增长 15%，金额 88888.88 元。';
    const r = auditReport(md, facts);
    assert.ok(r.unknown.includes('88888.88'), `未知金额未被识别：${JSON.stringify(r.unknown)}`);
    // 已知局限：份数/百分比与单位的组合太容易和日期、序号混淆，只核金额层面的数字
    assert.equal(r.unknown.includes('15'), false);
  });

  it('日期、百分比、量词不算金额，不参与对账', () => {
    const md = '2026 年 8 月完成 26 条日报，结算覆盖率 65%，涉及 12 家供应商。';
    const r = auditReport(md, facts);
    assert.deepEqual(r.unknown, []);
  });

  it('日期里的数字（含负号片段）不算金额', () => {
    const r = auditReport('统计区间：2026-08-01 至 2026-10-19，共 80 天。', facts);
    assert.deepEqual(r.unknown, []);
  });

  it('万元写法按 ×10000 折算后比对', () => {
    const r = auditReport('垫资 5 万元，自营合同额 1200 万元。', facts);
    // 5 万 = 50000 元，事实里没有；1200 万 = 12000000 元，正是自营合同额的折算值
    assert.ok(r.unknown.includes('5万'), `实际：${JSON.stringify(r.unknown)}`);
    assert.equal(r.unknown.includes('1200万'), false);
  });

  it('带千分位的金额也能认出来', () => {
    const r = auditReport('累计合同金额 980,000.00 元。', facts);
    assert.deepEqual(r.unknown, []);
  });

  it('未知数字去重且数量有上限（避免提示区被刷屏）', () => {
    const md = Array.from({ length: 40 }, (_, i) => `${i + 9000}.5`).join('，');
    const r = auditReport(md, facts);
    assert.equal(new Set(r.unknown).size, r.unknown.length);
    assert.ok(r.unknown.length <= 20);
  });

  it('空材料不抛错', () => {
    assert.deepEqual(auditReport('', facts), { unknown: [], checked: 0 });
    assert.deepEqual(auditReport(null as any, facts), { unknown: [], checked: 0 });
  });
});

describe('markdownToHtml：导出 docx 用的极简转换', () => {
  it('标题 / 列表 / 粗体', () => {
    const html = markdownToHtml('# 标题\n\n## 小节\n\n- 一条 **重点**\n- 两条\n\n1. 先\n2. 后\n\n普通段落');
    assert.ok(html.includes('<h1>标题</h1>'));
    assert.ok(html.includes('<h2>小节</h2>'));
    assert.ok(html.includes('<li>一条 <strong>重点</strong></li>'));
    assert.ok(html.includes('<ol>'));
    assert.ok(html.includes('<p>普通段落</p>'));
  });

  it('表格转成 <table>，分隔行被丢掉', () => {
    const html = markdownToHtml('| 项目 | 金额 |\n| --- | --- |\n| 合同 | 100 |');
    assert.ok(html.includes('<th>项目</th>'));
    assert.ok(html.includes('<td>合同</td>'));
    assert.equal(html.includes('---'), false);
  });

  it('HTML 特殊字符被转义（材料里可能出现 < > &）', () => {
    const html = markdownToHtml('金额 <100 万元 & 供应商 > 3 家');
    assert.ok(html.includes('&lt;100'));
    assert.ok(html.includes('&amp;'));
    assert.ok(html.includes('&gt;'));
  });

  it('列表与表格正确闭合', () => {
    const html = markdownToHtml('- a\n- b\n\n| x |\n| - |\n| 1 |');
    assert.ok(html.includes('</ul>'));
    assert.ok(html.includes('</table>'));
  });

  it('空输入返回空 body', () => {
    assert.equal(markdownToHtml(''), '<html><body></body></html>');
  });
});

describe('REPORT_KINDS：三种材料的标签齐备', () => {
  it('每种都有中文标签与写作提示', () => {
    for (const k of ['monthly', 'project', 'brief'] as const) {
      assert.ok(REPORT_KINDS[k].label.length > 0);
      assert.ok(REPORT_KINDS[k].hint.length > 0);
    }
  });
});
