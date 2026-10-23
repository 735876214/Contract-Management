/**
 * 课题 6-9 / 3-9 / 4-9 / 7-11 · **审计回归用例**（`docs/AI应用审计报告-2026-10-23.md`）。
 *
 * 这份 spec 的存在理由只有一个：审计里每一条「高危/中危」都是**用真实落库形状**复现出来的，
 * 修完之后必须留下来当护栏——用夹具形状测永远测不出这些坑（夹具是我们自己捏的，
 * 捏的时候就已经把冲突抹平了）。
 *
 * 因此这里每条断言都标注审计编号，数据刻意采用生产形状：
 * 对比表行的 materialBaseId 是总清单行 id、终结点状态只有 PENDING_ATTACHMENT/SETTLED、
 * 节点 statusCode 为 null、付款挂在补充协议上……
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { r2Overpay, r4InvoiceMismatch } from '../src/modules/ai/anomaly/rules-payment.ts';
import { resolveTolerances } from '../src/modules/ai/anomaly/anomaly-types.ts';
import type { PaymentAnomalyInput } from '../src/modules/ai/anomaly/anomaly-types.ts';
import { c3SequenceInverted, c6ProgressPaymentGap, c7SettledUnfinished } from '../src/modules/ai/fulfillment/rules-fulfillment.ts';
import { resolveFulfillmentTolerances } from '../src/modules/ai/fulfillment/fulfillment-types.ts';
import type { FulfillmentContractRow, FulfillmentInput } from '../src/modules/ai/fulfillment/fulfillment-types.ts';
import { evaluateQuoteAnomalies } from '../src/modules/ai/quote/rules-quote.ts';
import { auditNarrativeNumbers } from '../src/modules/ai/common/narrative.ts';
import { auditNumbers } from '../src/modules/ai/report-facts.ts';
import { buildScmFacts, scmFactNumbers } from '../src/modules/ai/analysis/scm-facts.ts';
import { parseScmConfig, SCM_PARAM_KEYS } from '../src/modules/ai/analysis/scm-config.ts';

const payCtx = () => ({ tol: resolveTolerances(), notEvaluated: [] as string[] });
const fulCtx = () => ({
  now: new Date('2026-10-23T00:00:00+08:00'),
  tol: resolveFulfillmentTolerances(),
  notEvaluated: [] as string[],
});

// ---------------------------------------------------------------- H2 / M7

test('H2：结算金额没填 → 不得据「0」判超付，必须进 notEvaluated', () => {
  const input: PaymentAnomalyInput = {
    contracts: [{ id: 'C1', code: 'HT-2026-001', status: 'SIGNED', currentPayRatio: 0.8, amount: '100000.00' }],
    // 生产里历史导入的结算单常见 amount/actualAmount 双空
    settlements: [{ id: 'S1', contractId: 'C1', code: 'JS-001', amount: null, actualAmount: null, settleDate: new Date('2026-03-01'), statusCode: 'CONFIRMED', items: [] }],
    payments: [{ id: 'P1', contractId: 'C1', amount: '5000.00', payDate: new Date('2026-03-10'), statusCode: 'PAID' }],
  };
  const ctx = payCtx();
  const r = r2Overpay(input, ctx);
  assert.deepEqual(r.findings, [], '金额未填不能推出「超付」');
  assert.ok(
    ctx.notEvaluated.some((n) => n.includes('没有金额')),
    `必须说明原因，实际 ${JSON.stringify(ctx.notEvaluated)}`,
  );
});

test('M7：R4 把「草稿结算」与「不在本项目」分开说，且按发票汇总而不是逐张刷', () => {
  const input: PaymentAnomalyInput = {
    contracts: [{ id: 'C1', code: 'HT-2026-001', status: 'SIGNED' }],
    settlements: [{ id: 'S1', contractId: 'C1', code: 'JS-001', amount: '1000.00', settleDate: new Date('2026-03-01'), statusCode: 'CONFIRMED', items: [] }],
    // 累计口径里能看到「草稿结算」与「完全不存在的结算单」的差别
    cumulativeSettlements: [
      { id: 'S1', contractId: 'C1', code: 'JS-001', amount: '1000.00', settleDate: new Date('2026-03-01'), statusCode: 'CONFIRMED', items: [] },
      { id: 'SD', contractId: 'C1', code: 'JS-DRAFT', amount: '2000.00', settleDate: new Date('2026-03-02'), statusCode: 'DRAFT', items: [] },
    ],
    payments: [],
    invoices: [
      { id: 'I1', settlementId: 'SD', amountWithTax: '2000.00', statusCode: 'VERIFIED' },
      { id: 'I2', settlementId: 'SD', amountWithTax: '500.00', statusCode: 'VERIFIED' },
      { id: 'I3', settlementId: 'S-GONE', amountWithTax: '700.00', statusCode: 'VERIFIED' },
    ],
  };
  const ctx = payCtx();
  r4InvoiceMismatch(input, ctx);
  const draft = ctx.notEvaluated.filter((n) => n.includes('草稿'));
  const absent = ctx.notEvaluated.filter((n) => n.includes('不在本项目'));
  assert.equal(draft.length, 1, `草稿应汇总成一条，实际 ${JSON.stringify(ctx.notEvaluated)}`);
  assert.ok(draft[0].includes('2 张'), '草稿张数应汇总');
  assert.equal(absent.length, 1, '「不在本项目」应汇总成一条');
  assert.ok(absent[0].includes('1 张'));
  assert.equal(
    ctx.notEvaluated.some((n) => n.includes('跨项目数据串了')),
    false,
    '不得把区间裁剪误诊成跨项目串数据',
  );
});

// ---------------------------------------------------------------- H10 / M2 / M3 / L1

const fulContracts = (): FulfillmentContractRow[] => [
  { id: 'M', code: 'HT-2026-100', name: '母合同', amount: '1000.00', status: 'SIGNED', signedDate: '2026-01-01', changeAmount: '0' } as any,
  { id: 'S', code: 'BC-2026-101', name: '补充协议', amount: '800.00', status: 'SIGNED', signedDate: '2026-02-01', parentContractId: 'M' } as any,
];

test('H10/M2：付款记在补充协议上，C6 必须按整链口径算（否则静默不报）', () => {
  const input: FulfillmentInput = {
    now: new Date('2026-10-23T00:00:00+08:00'),
    contracts: fulContracts(),
    milestones: [
      // 母合同只剩一个未完成节点 → 完成率 0%
      { id: 'm1', contractId: 'M', name: '竣工验收', planDate: new Date('2026-09-01'), actualDate: null, statusCode: null } as any,
    ],
    payments: [{ id: 'p1', contractId: 'S', amount: '550.00', payDate: new Date('2026-09-10') } as any],
  };
  const found = c6ProgressPaymentGap(input, fulCtx());
  assert.equal(found.length, 1, '付款挂补充协议时也必须判定出来');
  assert.equal(found[0].contractId, 'M');
});

test('M3：C7 只认终结点字典里真有的「已定案」，待补附件不算', () => {
  const base = {
    contracts: fulContracts(),
    milestones: [{ id: 'm1', contractId: 'M', name: '竣工验收', planDate: new Date('2026-09-01'), actualDate: null, statusCode: null } as any],
  };
  const pending = c7SettledUnfinished(
    { ...base, finalSettlements: [{ id: 'f1', contractId: 'M', statusCode: 'PENDING_ATTACHMENT' }] } as any,
    new Map(fulContracts().map((c) => [c.id, c])),
  );
  assert.equal(pending.length, 0, '待补附件 ≠ 已出终期结算');
  const settled = c7SettledUnfinished(
    { ...base, finalSettlements: [{ id: 'f2', contractId: 'M', statusCode: 'SETTLED' }] } as any,
    new Map(fulContracts().map((c) => [c.id, c])),
  );
  assert.equal(settled.length, 1, '已定案却还有未完成节点 → 必须报');
});

test('L1：同日并行节点不算「后继」，不判顺序倒挂', () => {
  const contracts = new Map([['C1', { id: 'C1', code: 'HT-2026-200' } as any]]);
  const rows = [
    { id: 'a', contractId: 'C1', name: '到货', planDate: new Date('2026-05-01'), actualDate: null, statusCode: null },
    { id: 'b', contractId: 'C1', name: '初验', planDate: new Date('2026-05-01'), actualDate: new Date('2026-05-01'), statusCode: 'DONE' },
  ] as any;
  assert.deepEqual(c3SequenceInverted(rows, contracts), [], '同日并行不该判倒挂');
  const later = [...rows, { id: 'c', contractId: 'C1', name: '终验', planDate: new Date('2026-06-01'), actualDate: new Date('2026-06-02'), statusCode: 'DONE' }] as any;
  assert.equal(c3SequenceInverted(later, contracts).length, 1, '真有更晚的已完成后继时仍要报');
});

// ---------------------------------------------------------------- H5

test('H5：价格对比表行的 materialBaseId 是总清单行 id 时，B4 仍要拿到市场价', () => {
  const items = [
    { id: 'ti-1', materialBaseId: 'mb-1', materialName: '水泥', spec: 'P.O42.5', unit: 't', qty: 100, planPrice: 1200, marketPrice: 950, infoPrice: 1200 },
  ];
  const compareItems = [
    { materialBaseId: 'ti-1', materialName: '水泥', spec: 'P.O42.5', unit: 't', qty: 100, planPrice: 1200, infoPrice: 1200, dealPrice: 1100 },
  ];
  const r = evaluateQuoteAnomalies({
    tasks: [{ task: { id: 'T1', taskNo: 'PROC-2026-001', status: 'COMPLETED' }, bidders: [], items, compareItems }],
  } as any);
  const hit = r.findings.find((f) => f.code === 'B4_PRICE_VS_MARKET');
  assert.ok(hit, `真实形状下 B4 必须命中，实际 ${JSON.stringify(r.findings.map((f) => f.code))}`);
  assert.ok(hit!.facts.some((x) => x.includes('950.00')), '市场价必须来自总清单行');
});

// ---------------------------------------------------------------- H6 / H7 / H8 / M1 / L3

test('H6：节点 statusCode 为 null（UI 新建节点不传状态）也算逾期', () => {
  const facts = buildScmFacts(
    {
      projects: [{ id: 'p1', code: 'XM-2026-003', name: '测试项目' }],
      contracts: [{ id: 'c1', projectId: 'p1', code: 'HT-2026-001', name: '合同一', status: 'SIGNED', amount: '100.00', changeAmount: '0' }],
      settlements: [],
      payments: [],
      invoices: [],
      // 里程碑行是原始 Prisma 形状：`projectId` 必须在（原测试漏了它 → 被 known.has 过滤掉，误以为规则没生效）
      milestones: [
        { id: 'm1', projectId: 'p1', contractId: 'c1', name: '节点一', planDate: new Date('2026-09-01'), actualDate: null, statusCode: null },
        { id: 'm2', projectId: 'p1', contractId: 'c1', name: '节点二', planDate: new Date('2026-09-02'), actualDate: new Date('2026-09-02'), statusCode: 'DONE' },
      ],
      suppliers: [],
    } as any,
    '2026-10-23',
  );
  assert.equal(facts.totals.overdueMilestones, 1, 'statusCode=null 的过期节点必须计入');
});

test('H7/H8：风险条里的数字与带编号的项目都能过对账', () => {
  const facts = buildScmFacts(
    {
      projects: [{ id: 'p1', code: 'XM-2026-003', name: '测试项目' }],
      contracts: [{ id: 'c1', projectId: 'p1', code: 'HT-2026-001', name: '合同一', status: 'SIGNED', amount: '1000000.00', changeAmount: '0' }],
      // 有结算、没开票 → 必然触发「开票落后」风险条（本用例要的正是「有风险时正文还能过对账」）
      settlements: [{ id: 's1', projectId: 'p1', contractId: 'c1', code: 'JS-001', amount: '400000.00', actualAmount: null, settleDate: new Date('2026-09-10'), statusCode: 'CONFIRMED' }],
      payments: [],
      invoices: [],
      milestones: [],
      suppliers: [],
    } as any,
    '2026-10-23',
  );
  assert.ok(facts.risks.length > 0, '该数据应产生风险条');
  const nums = scmFactNumbers(facts);
  const md = `项目 XM-2026-003 存在风险：${facts.risks.join('；')}。`;
  assert.deepEqual(auditNumbers(md, nums).unknown, [], '风险正文（含编号）不得被判编造');
});

test('M1：命中条数超过 10 时，模型复述总数不算编造', () => {
  const findings = Array.from({ length: 12 }, (_, i) => ({
    code: 'B1_DROP_EXCESS',
    title: `单位${i} 第二轮降幅 30.00%`,
    facts: ['降幅 30.00%', '阈值 20.00%'],
  }));
  const narrative = { conclusion: '本次扫描命中 12 项疑点（高风险 0 项、需复核 12 项）。', actions: [] as string[] };
  assert.deepEqual(auditNarrativeNumbers(narrative, findings as any), ['12'], '不给 extras 时仍应判出来（说明这个坑真实存在）');
  assert.deepEqual(
    auditNarrativeNumbers(narrative, findings as any, ['采购任务 2', '共 12 项（高风险 0，需复核 12）']),
    [],
    '提示词里给过样本/汇总数字后必须放行',
  );
});

test('L3：正常精度范围内的百分比不能被报成「超出 0–100 范围」', () => {
  const cfg = parseScmConfig({ [SCM_PARAM_KEYS.invoiceGapPct]: '50.05' });
  const msg = cfg.problems.join(' ');
  assert.equal(msg.includes('超出 0–100 范围'), false, `实际提示：${msg}`);
  assert.ok(msg.includes('一位小数'), `应提示精度截断，实际：${msg}`);
});
