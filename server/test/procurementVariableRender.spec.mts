import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replaceProcurementVariables, PROCUREMENT_VAR_ALIASES } from '../../web/src/constants/procurementVariables.ts';
import {
  buildPreMeetingVariableValues,
  calcBenefitRate,
  calcBenefitWan,
  calcCostWan,
  costRowsFromTotalList,
  deriveCostRow,
  fmtWan,
  summarizeCost,
} from '../../web/src/utils/preMeetingMinutes.ts';
import { buildResultReportVariableValues, fmtAmount, numOrNull } from '../../web/src/utils/procurementResultReport.ts';
import { amountToChineseCapital } from '../../web/src/utils/money.ts';
import { highlightPlaceholders } from '../../web/src/utils/docExport.ts';

/**
 * 采购变量的**取值行为**单测（docs/06 修复项的回归锁定）。
 *
 * 与 `procurementVariables.spec.mts`（结构一致性）分工不同：本文件锁定「算出来的值对不对」——
 * 尤其金额单位口径（万元 / 元）、废弃别名解析、占位符保留与转义规则。
 * 全部为纯函数，无 DOM / 无 DB 依赖。
 */

const CTX = {
  projectName: '滨江商务中心',
  projectAbbr: '滨江',
  undertaker: '中建八局',
  provinceCity: '浙江省杭州市',
  siteLocation: '滨江区',
  projectAddress: '杭州市滨江区xx路1号',
  materialOrigin: '河北唐山',
  content: '钢筋采购',
};

describe('金额口径与格式化', () => {
  it('万元格式：保留 2 位小数并带千分位；空值返回空串', () => {
    assert.equal(fmtWan(1234567.891), '1,234,567.89');
    assert.equal(fmtWan(0), '0.00');
    assert.equal(fmtWan(null), '');
    assert.equal(fmtWan(undefined), '');
    assert.equal(fmtWan('abc' as never), '');
  });

  it('元格式：保留 2 位小数并带千分位；空值返回空串', () => {
    assert.equal(fmtAmount(1234567.891), '1,234,567.89');
    assert.equal(fmtAmount(0), '0.00');
    assert.equal(fmtAmount(null), '');
    assert.equal(fmtAmount(''), '');
    assert.equal(fmtAmount('not-a-number'), '');
  });

  it('numOrNull：非数值 / 空 → null（避免 NaN 渗入金额）', () => {
    assert.equal(numOrNull('12.5'), 12.5);
    assert.equal(numOrNull(''), null);
    assert.equal(numOrNull(null), null);
    assert.equal(numOrNull(undefined), null);
    assert.equal(numOrNull('xx'), null);
  });

  it('合同额大写：非负金额可读，0 亦有值', () => {
    assert.equal(typeof amountToChineseCapital(12345.67), 'string');
    assert.ok(amountToChineseCapital(12345.67).includes('元'));
    assert.ok(amountToChineseCapital(0).length > 0);
  });
});

describe('「预计采购金额」单位口径（docs/06 #1 回归锁定）', () => {
  const reportData = {
    unitCount: 1,
    openTime: '2026-10-01',
    openPlace: '会议室',
    reviewMembers: '张三',
    approvedCount: 1,
    participantCount: 1,
    abstainCount: 0,
    validFileCount: 1,
    suppliers: [],
    candidates: [],
  };
  const meetingData = {
    meetingTime: '2026-10-01',
    content: '钢筋采购',
    host: '张三',
    attendees: '李四',
    writer: '张三',
    reviewer: '李四',
    techQuality: '',
    acceptance: '',
    paymentTerms: '',
    purchaseItems: [],
    costRows: [],
  };

  it('采前会取「万元」口径：同一任务下与成交报告的「元」口径相差 10000 倍也不会串', () => {
    // 同一笔 123.45 万元 = 1,234,500 元
    const meetingValues = buildPreMeetingVariableValues(meetingData as never, { ...CTX, estimatedAmountWan: 123.45 } as never);
    const reportValues = buildResultReportVariableValues(reportData as never, { ...CTX, estimatedAmount: 1234500 } as never);
    assert.equal(meetingValues['预计采购金额(万元)'], '123.45');
    assert.equal(reportValues['预计采购金额(元)'], '1,234,500.00');
  });

  it('两模块都**不再**产出不带单位的裸变量名「预计采购金额」', () => {
    const meetingValues = buildPreMeetingVariableValues(meetingData as never, { ...CTX, estimatedAmountWan: 1 } as never);
    const reportValues = buildResultReportVariableValues(reportData as never, { ...CTX, estimatedAmount: 1 } as never);
    assert.ok(!('预计采购金额' in meetingValues));
    assert.ok(!('预计采购金额' in reportValues));
  });
});

describe('占位符替换规则', () => {
  it('普通变量按文本转义（防 HTML 注入）', () => {
    const out = replaceProcurementVariables('{{项目名称}}', { 项目名称: '<b>x</b>' }, 'NOTICE');
    assert.equal(out, '&lt;b&gt;x&lt;/b&gt;');
  });

  it('HTML 变量原样注入（不转义）', () => {
    const out = replaceProcurementVariables('{{技术质量标准}}', { 技术质量标准: '<p>国标</p>' }, 'NOTICE');
    assert.equal(out, '<p>国标</p>');
  });

  it('表格变量原样注入（不转义）', () => {
    const out = replaceProcurementVariables('{{采购公告-采购清单}}', { '采购公告-采购清单': '<table><tr/></table>' }, 'NOTICE');
    assert.equal(out, '<table><tr/></table>');
  });

  it('未提供值的变量保留原占位符（便于预览时发现缺失）', () => {
    const out = replaceProcurementVariables('{{项目名称}}-{{未定义变量}}', { 项目名称: 'A' }, 'NOTICE');
    assert.equal(out, 'A-{{未定义变量}}');
  });

  it('值为 null / undefined 的变量不被替换（保留占位符）', () => {
    assert.equal(replaceProcurementVariables('{{项目名称}}', { 项目名称: null as never }, 'NOTICE'), '{{项目名称}}');
  });

  it('同一变量多次出现全部替换', () => {
    assert.equal(replaceProcurementVariables('{{项目名称}}{{项目名称}}', { 项目名称: 'A' }, 'NOTICE'), 'AA');
  });
});

describe('废弃别名兼容（docs/06 #3 回归锁定）', () => {
  const CASES: Array<[string, string]> = [
    ['技术质量要求', '技术质量标准'],
    ['验收标准', '验收方式'],
    ['付款条件', '付款方式'],
  ];

  for (const [alias, canonical] of CASES) {
    it(`旧名 {{${alias}}} 仍被替换为「${canonical}」的值`, () => {
      assert.equal(PROCUREMENT_VAR_ALIASES[alias], canonical, `别名映射缺失：${alias}`);
      const out = replaceProcurementVariables(`{{${alias}}}`, { [canonical]: '<p>值</p>' }, 'PRE_MEETING');
      assert.equal(out, '<p>值</p>');
    });

    it(`旧名 {{${alias}}} 作为 HTML 变量原样注入，不被转义`, () => {
      const out = replaceProcurementVariables(`{{${alias}}}`, { [canonical]: '<p>a &amp; b</p>' }, 'PRE_MEETING');
      assert.equal(out, '<p>a &amp; b</p>');
    });
  }

  it('显式传入别名取值时优先于规范名（不被覆盖）', () => {
    const out = replaceProcurementVariables(
      '{{技术质量要求}}',
      { 技术质量标准: '规范值', 技术质量要求: '别名值' },
      'PRE_MEETING',
    );
    assert.equal(out, '别名值');
  });
});

describe('采购成本分析计算（金额换算）', () => {
  it('预计采购成本（万元）= 控制价（元）× 数量 ÷ 10000', () => {
    assert.equal(calcCostWan(100, 10), 0.1); // 100 元 × 10 = 1000 元 = 0.1 万元
    assert.equal(calcCostWan(null, 10), 0);
    assert.equal(calcCostWan(100, null), 0);
  });

  it('预计效益额（万元）= 清单收入 − 预计采购成本；效益率按合计口径', () => {
    assert.equal(calcBenefitWan(10, 9), 1);
    assert.equal(calcBenefitRate(10, 1), 10);
    assert.equal(calcBenefitRate(0, 5), 0); // 收入为 0 时按 0 处理，不产生 Infinity/NaN
  });

  it('deriveCostRow 产出四要素且已 round 到 2 位', () => {
    const row = deriveCostRow({ income: 10, cost: 9 } as never);
    assert.deepEqual(row, { income: 10, cost: 9, benefit: 1, rate: 10 });
  });

  it('summarizeCost 逐行汇总，且合计效益率按合计口径重算（非各行平均）', () => {
    const total = summarizeCost([
      { income: 100, cost: 90 } as never,
      { income: 0, cost: 0 } as never,
    ]);
    assert.equal(total.income, 100);
    assert.equal(total.cost, 90);
    assert.equal(total.benefit, 10);
    assert.equal(total.rate, 10);
  });

  it('costRowsFromTotalList 把「元」单价 × 数量换算为「万元」', () => {
    const rows = costRowsFromTotalList([
      { materialName: '钢筋', spec: 'HRB400', qty: 10, incomePrice: 120, planPrice: 100 },
    ]);
    assert.equal(rows.length, 1);
    // 收入 120 元 × 10 = 1200 元 = 0.12 万元；成本 100 元 × 10 = 1000 元 = 0.1 万元
    assert.equal(rows[0].income, 0.12);
    assert.equal(rows[0].cost, 0.1);
  });
});

describe('占位符高亮（docs/06 #6 回归锁定）', () => {
  it('双花括号整体高亮（旧实现靠匹配内层 {x} 间接生效）', () => {
    const out = highlightPlaceholders('<p>{{项目名称}}</p>');
    assert.ok(out.includes('>{{项目名称}}<'), `双花括号应整体高亮，实际：${out}`);
  });

  it('**回归锁**：单花括号不再高亮（合同模板遗留语法已移除，docs/06 #5/#6）', () => {
    // 旧实现会把 `{合同额}` 也高亮；现在只认双花括号——否则富文本里的 `{color:red}` 之类会被误标
    assert.equal(highlightPlaceholders('{合同额}'), '{合同额}');
    assert.equal(highlightPlaceholders('.x{color:red}'), '.x{color:red}');
  });

  it('纯空白花括号不视为占位符', () => {
    assert.equal(highlightPlaceholders('{ }'), '{ }');
    assert.equal(highlightPlaceholders('{{ }}'), '{{ }}');
  });
});
