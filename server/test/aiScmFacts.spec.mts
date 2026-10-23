/**
 * 供应链运营全景（课题 7-11）事实层单测。
 *
 * 断言集中在**口径**上（这一层是「数字怎么来」的唯一出处，口径错一处全景全错）：
 * 1. 签约额按**合同链**聚合（主合同金额 + 补充协议 `changeAmount` 带符号增量）；
 * 2. 未签（`DRAFT`）合同、草稿结算、`FAILED`/`REFUNDED` 付款、`RED`/`CANCELLED` 发票都不计入；
 * 3. 主合同金额未填 → **不计入且单独提示**（「未填 ≠ 0」）；
 * 4. 逾期节点 = `PENDING` 且计划日早于基准日（与页面标红同口径）；
 * 5. 比例的分母为 0 时返回 `null`（不是 0%），前端显示「—」；
 * 6. 风险提示全部由程序判定（付款超结算、开票缺口、节点逾期、供应商集中度）。
 *
 * 事实层不读系统时钟（`asOf` 注入），所以断言不随日期漂移。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildScmFacts,
  scmFactNumbers,
  scmFactsToMarkdown,
} from '../src/modules/ai/analysis/scm-facts.ts';
import { parseScmConfig } from '../src/modules/ai/analysis/scm-config.ts';
import { DEFAULT_SCM_TOLERANCES, type ScmRows } from '../src/modules/ai/analysis/scm-types.ts';

const AS_OF = '2026-10-25';

/** 两个项目：P1 数据齐全（含补充协议），P2 只有草稿合同 + 一条主合同金额未填的已签合同 */
function fixture(): ScmRows {
  return {
    projects: [
      { id: 'p1', code: 'XM-2026-01', name: '一号项目' },
      { id: 'p2', code: 'XM-2026-02', name: '二号项目' },
    ],
    contracts: [
      // P1 主合同 100 万，已签
      { id: 'c1', projectId: 'p1', supplierId: 's1', status: 'SIGNED', amount: '1000000.00' },
      // P1 补充协议：增项 +10 万（只认 changeAmount）
      {
        id: 'c1s',
        projectId: 'p1',
        supplierId: 's1',
        status: 'SIGNED',
        amount: '999999.00',
        changeAmount: '100000.00',
        parentContractId: 'c1',
      },
      // P2 草稿合同：不进全景
      { id: 'c2', projectId: 'p2', supplierId: 's2', status: 'DRAFT', amount: '500000.00' },
      // P2 已签但主合同金额未填：不计入签约额，但要提示
      { id: 'c3', projectId: 'p2', supplierId: 's1', status: 'SIGNED', amount: null },
    ],
    settlements: [
      { id: 'st1', projectId: 'p1', statusCode: 'CONFIRMED', amount: '400000.00', actualAmount: '380000.00' },
      // 草稿结算：不计入
      { id: 'st2', projectId: 'p1', statusCode: 'DRAFT', amount: '990000.00' },
      { id: 'st3', projectId: 'p2', statusCode: 'CONFIRMED', amount: '20000.00' },
    ],
    payments: [
      { id: 'pm1', projectId: 'p1', statusCode: 'PAID', amount: '400000.00' },
      // 失败付款：不计入
      { id: 'pm2', projectId: 'p1', statusCode: 'FAILED', amount: '888888.00' },
      { id: 'pm3', projectId: 'p2', statusCode: 'PAID', amount: '25000.00' },
    ],
    invoices: [
      { id: 'iv1', projectId: 'p1', statusCode: 'VERIFIED', amountWithTax: '200000.00' },
      // 红冲：不计入
      { id: 'iv2', projectId: 'p1', statusCode: 'RED', amountWithTax: '777777.00' },
    ],
    milestones: [
      // 真实库里 contractId 恒非空（外键 NOT NULL）：夹具必须一样，否则节点会被当成「无合同归属」跳过
      { id: 'm1', projectId: 'p1', contractId: 'c1', statusCode: 'PENDING', planDate: '2026-09-01' },
      { id: 'm2', projectId: 'p1', contractId: 'c1', statusCode: 'DONE', planDate: '2026-08-01' },
      { id: 'm3', projectId: 'p1', contractId: 'c1', statusCode: 'PENDING', planDate: '2026-12-01' },
      { id: 'm4', projectId: 'p2', contractId: 'c3', statusCode: 'SKIPPED', planDate: '2026-01-01' },
    ],
    suppliers: [
      { id: 's1', name: '甲建设' },
      { id: 's2', name: '乙劳务' },
    ],
  };
}

test('buildScmFacts：签约额按合同链聚合，补充协议只算 changeAmount', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  const p1 = facts.projects.find((p) => p.projectId === 'p1')!;
  assert.equal(p1.contractCount, 1); // 主合同 + 补充协议 = 1 条链
  assert.equal(p1.signedYuan, 1100000); // 100 万 + 10 万，而不是 + 99.9999 万
});

test('buildScmFacts：草稿合同/草稿结算/失败付款/红冲发票都不计入', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  const p1 = facts.projects.find((p) => p.projectId === 'p1')!;
  const p2 = facts.projects.find((p) => p.projectId === 'p2')!;
  assert.equal(p2.contractCount, 1); // c3（已签）+ c2（草稿，排除）
  assert.equal(p2.signedYuan, 0); // c3 主合同金额未填
  assert.equal(p1.settledYuan, 380000); // actualAmount 优先，草稿结算不计
  assert.equal(p1.paidYuan, 400000); // FAILED 不计
  assert.equal(p1.invoicedYuan, 200000); // RED 不计
});

test('buildScmFacts：主合同金额未填不进签约额，但要作为数据缺口提示', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  const hit = facts.risks.some((r) => r.includes('XM-2026-02') && r.includes('未填主合同金额'));
  assert.ok(hit, `风险提示里应说明 P2 的金额缺口，实际：${facts.risks.join(' / ')}`);
});

test('buildScmFacts：逾期只看 PENDING 且计划日已过', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  const p1 = facts.projects.find((p) => p.projectId === 'p1')!;
  // m1 逾期；m2 已完成；m3 计划日未到
  assert.equal(p1.milestoneCount, 3);
  assert.equal(p1.overdueMilestones, 1);
  const p2 = facts.projects.find((p) => p.projectId === 'p2')!;
  assert.equal(p2.overdueMilestones, 0); // SKIPPED 不算逾期
  assert.equal(facts.totals.overdueMilestones, 1);
});

test('buildScmFacts：比例口径 —— 分母为 0 返回 null，付款超结算时未付为负', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  const p1 = facts.projects.find((p) => p.projectId === 'p1')!;
  const p2 = facts.projects.find((p) => p.projectId === 'p2')!;
  // 付款 400000 / 结算 380000 = 105.3%
  assert.equal(p1.payRatioPct, 105.3);
  // 结算 380000 / 签约 1100000 = 34.5%
  assert.equal(p1.settleRatioPct, 34.5);
  // 开票 200000 / 结算 380000 = 52.6%
  assert.equal(p1.invoiceRatioPct, 52.6);
  assert.equal(p1.unpaidYuan, -20000);
  assert.equal(p2.payRatioPct, 125); // 25000 / 20000
  assert.equal(p2.settleRatioPct, null); // 签约额为 0 → 无法计算，不是 0%
});

test('buildScmFacts：风险提示由程序判定（付款超结算 + 节点逾期）', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  assert.ok(facts.risks.some((r) => r.includes('付款已超过结算')), '应报付款超结算');
  assert.ok(facts.risks.some((r) => r.includes('履约节点逾期')), '应报节点逾期');
});

test('buildScmFacts：草稿/链断裂合同上的节点不算逾期，但要作为提示说出来', () => {
  const rows = fixture();
  rows.contracts = [
    ...rows.contracts,
    { id: 'c9', projectId: 'p2', supplierId: 's2', status: 'SIGNED', amount: '100.00', parentContractId: 'c-missing' },
  ];
  rows.milestones = [
    // 挂在草稿合同 c2 上：计划日已过，但合同还没签，不是承诺
    { id: 'm5', projectId: 'p2', contractId: 'c2', statusCode: 'PENDING', planDate: '2026-01-01' },
    // 父合同不在取数集合里（数据坏了）：链断裂，不猜归属
    { id: 'm6', projectId: 'p2', contractId: 'c9', statusCode: 'PENDING', planDate: '2026-01-01' },
  ] as any;
  const facts = buildScmFacts(rows, AS_OF);
  const p2 = facts.projects.find((p) => p.projectId === 'p2')!;
  assert.equal(p2.overdueMilestones, 0, '草稿合同与断链合同的节点都不该报逾期');
  assert.equal(p2.milestoneCount, 0);
  assert.ok(
    facts.risks.some((r) => r.includes('履约节点挂在未签 / 链断裂的合同上')),
    `应提示被跳过的节点，实际：${facts.risks.join(' / ')}`,
  );
  assert.ok(
    facts.risks.some((r) => r.includes('上级合同不在取数范围内')),
    `应提示断链合同，实际：${facts.risks.join(' / ')}`,
  );
});

test('buildScmFacts：父合同没签时补充协议不能单独当一份合同计签约额', () => {
  const rows = fixture();
  rows.contracts = [
    { id: 'p1root', projectId: 'p1', supplierId: 's1', status: 'DRAFT', amount: '500000.00' },
    {
      id: 'p1sub',
      projectId: 'p1',
      supplierId: 's1',
      status: 'SIGNED',
      amount: '0.00',
      changeAmount: '300000.00',
      parentContractId: 'p1root',
    },
  ];
  const facts = buildScmFacts(rows, AS_OF);
  const p1 = facts.projects.find((p) => p.projectId === 'p1')!;
  assert.equal(p1.contractCount, 0, '主合同没签，整条链都不算签约');
  assert.equal(p1.signedYuan, 0);
  assert.ok(
    facts.risks.some((r) => r.includes('主合同还没签')),
    `应提示未签链，实际：${facts.risks.join(' / ')}`,
  );
});

test('buildScmFacts：供应商集中度按签约额排，占比可对账', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  assert.equal(facts.suppliers.length, 1); // 只有 s1 有已签且金额已知的合同
  assert.equal(facts.suppliers[0].supplierId, 's1');
  assert.equal(facts.suppliers[0].signedYuan, 1100000);
  assert.equal(facts.suppliers[0].sharePct, 100);
});

test('buildScmFacts：空项目集 → empty=true，比例全 null，不抛错', () => {
  const facts = buildScmFacts(
    { projects: [], contracts: [], settlements: [], payments: [], invoices: [], milestones: [], suppliers: [] },
    AS_OF,
  );
  assert.equal(facts.empty, true);
  assert.equal(facts.totals.projectCount, 0);
  assert.equal(facts.totals.payRatioPct, null);
  // 空数据时也要能出报告（只说明没有数据，不许编）
  const md = scmFactsToMarkdown(facts);
  assert.ok(md.includes('# 供应链运营全景'));
  assert.ok(md.includes('## 一、总体情况'));
});

test('scmFactsToMarkdown：四个小节齐全，关键数字逐字出现', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  const md = scmFactsToMarkdown(facts);
  for (const section of ['一、总体情况', '二、项目对照', '三、供应商集中度', '四、风险与建议']) {
    assert.ok(md.includes(`## ${section}`), `缺小节：${section}`);
  }
  assert.ok(md.includes(AS_OF));
  assert.ok(md.includes('1,100,000.00')); // 签约额（千分位）
  assert.ok(md.includes('XM-2026-01'));
  assert.ok(md.includes('甲建设'));
});

test('scmFactNumbers：覆盖 totals/projects/suppliers 与项目编号里的数字', () => {
  const facts = buildScmFacts(fixture(), AS_OF);
  const nums = scmFactNumbers(facts);
  assert.ok(nums.includes(1100000));
  assert.ok(nums.includes(380000));
  assert.ok(nums.includes(105.3));
  assert.ok(nums.includes(2026)); // 基准日 / 项目编号
  assert.ok(nums.includes(1)); // XM-2026-01 的 01
});

test('parseScmConfig：非法参数回落默认并留人话，不抛错', () => {
  const cfg = parseScmConfig({
    'ai.analysis.enabled': '开',
    'ai.analysis.topSharePct': '120',
    'ai.analysis.invoiceGapPct': 'abc',
    'ai.analysis.topSuppliers': '99',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.tolerances.topSharePct, 100); // 夹到上限
  assert.equal(cfg.tolerances.invoiceGapPct, DEFAULT_SCM_TOLERANCES.invoiceGapPct); // 回落默认
  assert.equal(cfg.tolerances.topSuppliers, 20); // 夹到上限
  assert.ok(cfg.problems.length >= 2, `应有参数问题提示，实际：${JSON.stringify(cfg.problems)}`);
});
