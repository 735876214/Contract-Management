import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANOMALY_SELECT,
  buildAnomalyWhere,
  buildPaymentAnomalyInput,
  makeChainRootResolver,
  type AnomalyRows,
} from '../src/modules/ai/anomaly/anomaly-dataset.ts';
import { evaluatePaymentAnomalies } from '../src/modules/ai/anomaly/rules-payment.ts';

/**
 * 取数形状层的单测。
 * 这一层的价值不在"算什么"，而在**评测与线上用的是同一份形状**：
 * 一旦有人改了 `ANOMALY_SELECT` 或链根聚合，评测数字与线上行为就会分叉。
 */

const contract = (id: string, extra: Record<string, any> = {}) => ({
  id,
  parentContractId: null,
  code: `HT-${id}`,
  name: null,
  amount: '100000.00',
  status: 'SIGNED',
  execStatus: 'EXECUTING',
  ext: { currentPayRatio: '0.8000' },
  ...extra,
});

const material = (contractId: string, materialBaseId: string, qty: string, name: string) => ({
  contractId,
  materialBaseId,
  qty,
  materialBase: { name },
});

const emptyRows = (): AnomalyRows => ({
  contracts: [],
  settlements: [],
  payments: [],
  invoices: [],
  procedures: [],
  receipts: [],
  finalSettlementItems: [],
  materialRows: [],
});

test('链根解析：父链上溯到根，防环且命中缓存', () => {
  const rootOf = makeChainRootResolver([
    { id: 'C0', parentContractId: null },
    { id: 'C1', parentContractId: 'C0' },
    { id: 'C2', parentContractId: 'C1' },
    { id: 'X1', parentContractId: 'X1' }, // 自环：靠深度上限兜住
  ]);
  assert.equal(rootOf('C2'), 'C0');
  assert.equal(rootOf('C0'), 'C0');
  assert.equal(rootOf('X1'), 'X1');
  assert.equal(rootOf('不存在'), null);
});

test('清单量按链根聚合：补充协议的清单量并入母合同，且按物料求和', () => {
  const rows = emptyRows();
  rows.contracts = [contract('C0'), contract('C1', { parentContractId: 'C0' })];
  rows.materialRows = [
    material('C0', 'M0', '100.0000', '钢筋'),
    material('C1', 'M0', '50.0000', '钢筋'), // 同一物料：应相加
    material('C1', 'M1', '30.0000', '水泥'),
    material('CLOSED', 'M2', '9999.0000', '游离合同'), // 不在合同集合：丢弃
  ];
  const { input } = buildPaymentAnomalyInput(rows);
  const map = new Map(input.contractMaterials!.map((m) => [`${m.contractId}::${m.materialBaseId}`, m]));
  assert.equal(map.get('C0::M0')!.qty, 150);
  assert.equal(map.get('C0::M1')!.qty, 30);
  assert.equal(map.get('C0::M1')!.name, '水泥');
  assert.equal(input.contractMaterials!.length, 2, '游离合同的清单量不应进入入参');
  assert.ok(!map.has('C1::M0'), '聚合键必须是链根而不是签约主体');
});

test('行映射：currentPayRatio 从 ext 取，缺失时为 null（R2 将判定为"未判定"而不是超付）', () => {
  const rows = emptyRows();
  rows.contracts = [
    contract('C0'),
    contract('C1', { ext: null }),
    contract('C2', { ext: { currentPayRatio: null } }),
  ];
  const { input } = buildPaymentAnomalyInput(rows);
  assert.equal(input.contracts[0].currentPayRatio, '0.8000');
  assert.equal(input.contracts[1].currentPayRatio, null);
  assert.equal(input.contracts[2].currentPayRatio, null);
});

test('sample 计数：8 类单据各自计数，供面板说明"基于多少数据算的"', () => {
  const rows = emptyRows();
  rows.contracts = [contract('C0')];
  rows.settlements = [{ id: 'S1', contractId: 'C0', items: [] }];
  rows.payments = [{ id: 'P1', contractId: 'C0' }];
  rows.invoices = [{ id: 'I1', settlementId: 'S1' }];
  rows.procedures = [{ id: 'PR1', contractId: 'C0' }];
  rows.receipts = [{ id: 'R1', settlementId: 'S1' }];
  rows.finalSettlementItems = [{ id: 'F1', finalSettlementId: 'FS1' }];
  rows.materialRows = [material('C0', 'M0', '1.0000', '钢筋')];
  const { sample } = buildPaymentAnomalyInput(rows);
  assert.deepEqual(sample, {
    合同: 1,
    结算单: 1,
    付款: 1,
    发票: 1,
    付款手续: 1,
    收领单: 1,
    终期结算明细: 1,
    清单物资行: 1,
  });
});

test('where 构造：每个查询都显式带 projectId（铁律 3，跨项目串数据是事故）', () => {
  const w = buildAnomalyWhere({ from: null, to: null }, 'proj-1');
  for (const [name, where] of Object.entries(w)) {
    const text = JSON.stringify(where);
    assert.ok(text.includes('"projectId":"proj-1"'), `${name} 必须带 projectId，实际 ${text}`);
  }
  // 间接挂项目的两张表用嵌套形式，也必须收在项目内
  // 发票额外带 `settlement: {}`（空条件也保留关系过滤）：不给区间时也要走「挂到本项目结算单」这条路，
  // 否则一张挂别人项目的发票只要 settlementId 非空就能漏进来（H1 的同一处根因）。
  assert.deepEqual(w.invoiceWhere, {
    projectId: 'proj-1',
    settlementId: { not: null },
    settlement: {},
  });
  assert.deepEqual(w.finalSettlementItemWhere, { finalSettlement: { projectId: 'proj-1' } });
  assert.deepEqual(w.contractMaterialWhere, { contract: { projectId: 'proj-1' } });
});

test('where 构造：合同收窄与日期区间各自落到正确的字段', () => {
  const from = new Date('2026-01-01T00:00:00+08:00');
  const to = new Date('2026-03-31T23:59:59+08:00');
  const w = buildAnomalyWhere({ from, to, contractId: 'C9' }, 'proj-1');
  assert.deepEqual(w.contractWhere, { projectId: 'proj-1', id: 'C9' });
  assert.equal(w.settlementWhere.contractId, 'C9');
  assert.deepEqual(w.settlementWhere.settleDate, { gte: from, lte: to });
  // **区间口径一分为二**（H1）：
  // - 结算单：区间 = 判定对象（gte/lte 都加）；
  // - 付款/手续：只加上界（payDate ≤ 区间末），因为累计类规则必须看见区间之前已发生的付款；
  // - 发票：按挂靠的结算单日期只加上界。
  assert.deepEqual(w.paymentWhere, { projectId: 'proj-1', contractId: 'C9', payDate: { lte: to } });
  assert.deepEqual(w.procedureWhere, { projectId: 'proj-1', contractId: 'C9', payDate: { lte: to } });
  assert.deepEqual(w.settlementCumulativeWhere, {
    projectId: 'proj-1',
    contractId: 'C9',
    settleDate: { lte: to },
  });
  assert.deepEqual(w.invoiceWhere, {
    projectId: 'proj-1',
    settlementId: { not: null },
    settlement: { contractId: 'C9', settleDate: { lte: to } },
  });
});

test('select 形状：只取判定需要的窄列（回归护栏，防止有人顺手 SELECT *）', () => {
  // 关键窄列必须在；宽字段（如合同正文、备注）不该出现
  for (const key of ['id', 'contractId', 'amount', 'settleDate', 'statusCode'] as const) {
    assert.equal((ANOMALY_SELECT.settlement as any)[key], true, `settlement.select 缺少 ${key}`);
  }
  assert.deepEqual(ANOMALY_SELECT.contract.ext, { select: { currentPayRatio: true } });
  assert.deepEqual(ANOMALY_SELECT.contractMaterial.materialBase, { select: { name: true } });
  assert.equal((ANOMALY_SELECT.contract as any).content, undefined);
});

test('端到端：假 Prisma 行 → 规则命中（无合同付款 R3 高优先级）', () => {
  const rows = emptyRows();
  rows.contracts = [contract('C0')];
  rows.payments = [
    { id: 'P-NULL', contractId: null, amount: '5000.00', payDate: new Date('2026-02-01'), payMonth: null, statusCode: 'PAID' },
    { id: 'P-OK', contractId: 'C0', amount: '1000.00', payDate: new Date('2026-02-01'), payMonth: null, statusCode: 'PAID' },
  ];
  const { input } = buildPaymentAnomalyInput(rows);
  const evaluation = evaluatePaymentAnomalies(input);
  const r3 = evaluation.findings.filter((f) => f.code === 'R3_PAY_WITHOUT_CONTRACT');
  assert.equal(r3.length, 1);
  assert.equal(r3[0].entityId, 'P-NULL');
  assert.equal(r3[0].level, 'HIGH');
});
