import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_KINDS,
  auditReport,
  deltaOf,
  factNumbers,
  factsToMarkdown,
  markdownToHtml,
  type ReportDelta,
  type ReportFacts,
  type ReportWindow,
} from '../src/modules/ai/report-facts.ts';

/**
 * 汇报材料的事实包与产出对账。
 *
 * 底线：**材料里的数字必须能在事实清单里找到**。
 * 模型为了让句子顺会编「同比增长 15%」，`auditReport` 就是专门抓这个的——
 * 这条用例必须能失败，否则等于没写。
 *
 * 事实包是「本期 / 对比期 / 累计 / 环比」四段（2026-10 重构）：
 * 区间口径与项目累计分开，环比由程序算好（`deltaOf`），模型只许引用。
 */

const cur: ReportWindow = {
  period: { from: '2026-08-01', to: '2026-08-31', label: '2026-08-01 ~ 2026-08-31' },
  contractsSigned: 2,
  contractsSignedAmount: 36476.97,
  settlementCount: 3,
  settlementAmount: 150000,
  paymentCount: 2,
  paymentAmount: 120000,
  invoiceCount: 1,
  invoiceAmount: 80000,
  dailyReports: 26,
};

const prev: ReportWindow = {
  period: { from: '2026-07-01', to: '2026-07-31', label: '2026-07-01 ~ 2026-07-31' },
  contractsSigned: 1,
  contractsSignedAmount: 20000,
  settlementCount: 2,
  settlementAmount: 100000,
  paymentCount: 1,
  paymentAmount: 50000,
  invoiceCount: 0,
  invoiceAmount: 0,
  dailyReports: 0,
};

const d = (now: number, prevValue: number): ReportDelta => deltaOf(now, prevValue);

const facts: ReportFacts = {
  project: {
    name: '紫金街雨污分流工程',
    code: 'ZJX-01',
    manager: '张工',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    selfContractAmount: 1200,
  },
  current: cur,
  compare: prev,
  totals: {
    contracts: 12,
    executing: 5,
    contractAmount: 980000,
    settlementAmount: 600000,
    paymentAmount: 500000,
    invoiceAmount: 450000,
    unpaid: 100000,
  },
  deltas: {
    contractsSigned: d(cur.contractsSigned, prev.contractsSigned),
    contractsSignedAmount: d(cur.contractsSignedAmount, prev.contractsSignedAmount),
    settlementAmount: d(cur.settlementAmount, prev.settlementAmount),
    paymentAmount: d(cur.paymentAmount, prev.paymentAmount),
    invoiceAmount: d(cur.invoiceAmount, prev.invoiceAmount),
    dailyReports: d(cur.dailyReports, prev.dailyReports),
  },
  risks: ['存在应付未付 100000.00 元，需关注付款进度'],
};

describe('factsToMarkdown：事实清单要能直接抄', () => {
  const md = factsToMarkdown(facts);

  it('把关键金额与计数都列出来', () => {
    assert.ok(md.includes('36476.97'));
    assert.ok(md.includes('980000.00'));
    assert.ok(md.includes('100000.00'));
    assert.ok(md.includes('合同：12 份，其中执行中 5 份'));
    assert.ok(md.includes('日报：26 条'));
  });

  it('本期与对比期分开列，区间标签原样给出', () => {
    assert.ok(md.includes('【统计区间】2026-08-01 ~ 2026-08-31'));
    assert.ok(md.includes('【对比区间】2026-07-01 ~ 2026-07-31'));
    assert.ok(md.includes('【本期发生额】'));
    assert.ok(md.includes('【项目累计（不受区间限制）】'));
  });

  it('环比由程序算好写进清单（模型不许自己算）', () => {
    const pct = facts.deltas.contractsSignedAmount.pct;
    assert.ok(pct !== null);
    assert.ok(md.includes(`${pct! > 0 ? '+' : ''}${pct!.toFixed(2)}%`));
    // 上期为 0 的项明确写「无法计算」，不写百分比
    assert.ok(md.includes('上期为 0，无法计算环比'));
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

  it('环比的三段数值都进对账清单；上期为 0 时 pct 不进清单', () => {
    const nums = factNumbers(facts);
    const all = Object.values(facts.deltas);
    for (const item of all) {
      assert.ok(nums.includes(item.now), `now ${item.now} 缺失`);
      assert.ok(nums.includes(item.prev), `prev ${item.prev} 缺失`);
      if (item.pct !== null) assert.ok(nums.includes(Math.abs(item.pct)), `pct ${item.pct} 缺失`);
    }
    assert.ok(nums.includes(0));
  });
});

describe('auditReport：材料里的数字必须来自系统数据', () => {
  it('引用事实清单里的数字不报案（金额与计数都核）', () => {
    const text = '## 一、经营概况\n本月新签 2 份合同，金额 36476.97 元；累计已付款 500000.00 元。';
    const r = auditReport(text, facts);
    assert.deepEqual(r.unknown, []);
    // 「2 份」现在是参与对账的（contractsSigned=2 在清单里），所以 checked 把计数也算上
    assert.ok(r.checked >= 3);
  });

  it('编造的数字必须被抓出来（这是本模块存在的理由）', () => {
    const text = '本月新签 4 份合同，同比增长 15%，金额 88888.88 元。';
    const r = auditReport(text, facts);
    assert.ok(r.unknown.includes('88888.88'), `未知金额未被识别：${JSON.stringify(r.unknown)}`);
    // 2026-10-20 审计 P2：量词与百分号不再跳过，编造的份数与百分比也要抓
    assert.ok(r.unknown.includes('4'), `编造的份数未被识别：${JSON.stringify(r.unknown)}`);
    assert.ok(r.unknown.includes('15'), `编造的百分比未被识别：${JSON.stringify(r.unknown)}`);
  });

  it('真实的计数与百分比不报案；百分比容许取整', () => {
    // 26 条日报、12 份合同都在清单里；82.38% 被模型写成 82% 属合理取整
    const text = '2026 年 8 月完成 26 条日报，涉及 12 家供应商，金额环比增长 82%。';
    const r = auditReport(text, facts);
    assert.deepEqual(r.unknown, []);
  });

  it('有序列表的序号不报案（模型按提示写 1. / 2. / 3. 时实测误报过 2、3）', () => {
    const text = '1. 本月新签 2 份合同\n2. 结算金额 150000.00 元\n3) 已付款 120000.00 元';
    const r = auditReport(text, facts);
    assert.deepEqual(r.unknown, []);
  });

  it('日期里的数字（含负号片段）不算金额', () => {
    const r = auditReport('统计区间：2026-08-01 至 2026-10-19，共 26 天。', facts);
    assert.deepEqual(r.unknown, []);
  });

  it('万元写法按 ×10000 折算后比对', () => {
    const r = auditReport('垫资 3 万元，自营合同额 1200 万元。', facts);
    // 3 万 = 30000 元，事实里没有（5 万会命中对比期付款额，故选一个确实不存在的数）；
    // 1200 万 = 12000000 元，正是自营合同额的折算值
    assert.ok(r.unknown.includes('3万'), `实际：${JSON.stringify(r.unknown)}`);
    assert.equal(r.unknown.includes('1200万'), false);
  });

  it('带千分位的金额也能认出来', () => {
    const r = auditReport('累计合同金额 980,000.00 元。', facts);
    assert.deepEqual(r.unknown, []);
  });

  it('未知数字去重且数量有上限（避免提示区被刷屏）', () => {
    const text = Array.from({ length: 40 }, (_, i) => `${i + 9000}.5`).join('，');
    const r = auditReport(text, facts);
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
