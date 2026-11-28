// @domains: finance invoice final-settlement subcontractor repayment
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootIntApp,
  makeContract,
  makeProject,
  makeSupplier,
  readWebTypeKeys,
  type IntContext,
} from './helpers';
import { FinanceService } from '../src/modules/finance';
import { InvoiceService } from '../src/modules/invoice';
import { FinalSettlementService } from '../src/modules/final-settlement';
import { SubcontractorService } from '../src/modules/subcontractor';
import { RepaymentService } from '../src/modules/repayment';

/**
 * 集成测试 · **多域接口契约**（响应行字段集），锁住 `web/src/api/types/` 里各域的 `*_ROW_KEYS`：
 * finance / invoice / final-settlement / subcontractor / repayment。
 *
 * 这些域的共同点：列表/详情返回**原始 Prisma 行**（金额 Decimal → JSON string），
 * 且字段多、跨页消费，漂移会让页面读到 `undefined` 而静默空白。这里按「后端多返 / 少返必填」
 * 双向断言，与 `api-shape-ledger/contract` 同口径。
 */
describe('集成 · 多域接口契约（响应行字段集）', () => {
  let ctx: IntContext;

  before(async () => {
    ctx = await bootIntApp();
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 断言实际行键集与声明的 *_ROW_KEYS 双向一致（extra 为已知允许的补字段/关联）。 */
  function assertRowKeys(actualRow: Record<string, unknown>, declaredKeys: string[], label: string) {
    const actual = Object.keys(actualRow).sort();
    const undeclared = actual.filter((k) => !declaredKeys.includes(k));
    assert.deepEqual(undeclared, [], `${label}：后端多返回了未声明的字段（同步 web/src/api/types/）：\n  ${undeclared.join('\n  ')}`);
    const missing = declaredKeys.filter((k) => !actual.includes(k));
    assert.deepEqual(missing, [], `${label}：类型声明为必填但后端没返回：\n  ${missing.join('\n  ')}`);
  }

  it('前置：能从各类型文件抽出契约清单（防空转）', () => {
    assert.ok(readWebTypeKeys('web/src/api/types/finance.ts', 'FINANCE_FACTORING_ROW_KEYS').length >= 10);
    assert.ok(readWebTypeKeys('web/src/api/types/invoice.ts', 'INVOICE_ROW_KEYS').length >= 20);
    assert.ok(readWebTypeKeys('web/src/api/types/final-settlement.ts', 'FINAL_SETTLEMENT_ROW_KEYS').length >= 10);
    assert.ok(readWebTypeKeys('web/src/api/types/subcontractor.ts', 'SUBCONTRACTOR_ROW_KEYS').length >= 10);
    assert.ok(readWebTypeKeys('web/src/api/types/repayment.ts', 'REPAYMENT_ROW_KEYS').length >= 10);
  });

  it('分包商行字段集与声明一致（列表项含 ledgerCount）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-subcontractor');
    const svc = ctx.get<SubcontractorService>(SubcontractorService);
    await ctx.prisma.subcontractor.create({
      data: { projectId: project.id, name: `分包商 ${Date.now()}`, status: 1 } as any,
    });
    const res: any = await svc.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1);
    const declared = readWebTypeKeys('web/src/api/types/subcontractor.ts', 'SUBCONTRACTOR_ROW_KEYS');
    // projectId 可空、ledgerCount 列表项恒有；其余按声明
    assertRowKeys(res.list[0], declared, '分包商行');
  });

  it('保理费用台账行字段集与声明一致（金额是 Decimal string）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-factoring');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000 });
    const svc = ctx.get<FinanceService>(FinanceService);
    await ctx.prisma.factoringCost.create({
      data: {
        contractId: contract.id,
        seqNo: 1,
        financingAmount: 100,
        settlementMonth: '2026-01',
      } as any,
    });
    const res: any = await svc.listFactoring(contract.id, { page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1);
    const declared = readWebTypeKeys('web/src/api/types/finance.ts', 'FINANCE_FACTORING_ROW_KEYS');
    assertRowKeys(res.list[0], declared, '保理行');
    const asJson = JSON.parse(JSON.stringify(res.list[0]));
    assert.equal(typeof asJson.financingAmount, 'string', '保理金额经 JSON 后应是 string（Prisma Decimal 原样）');
  });

  it('发票行字段集与声明一致（金额是 Decimal string）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-invoice');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000 });
    const svc = ctx.get<InvoiceService>(InvoiceService);
    await ctx.prisma.invoice.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        invoiceNo: `INV-${Date.now()}`,
        amountBeforeTax: 100,
        amountWithTax: 113,
      } as any,
    });
    const res: any = await svc.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1);
    const declared = readWebTypeKeys('web/src/api/types/invoice.ts', 'INVOICE_ROW_KEYS');
    assertRowKeys(res.list[0], declared, '发票行');
    const asJson = JSON.parse(JSON.stringify(res.list[0]));
    assert.equal(typeof asJson.amountWithTax, 'string', '发票金额经 JSON 后应是 string（Prisma Decimal 原样）');
  });

  it('总结算单行字段集与声明一致（金额是 Decimal string）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-final-settlement');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000 });
    const svc = ctx.get<FinalSettlementService>(FinalSettlementService);
    await ctx.prisma.finalSettlement.create({
      data: { projectId: project.id, contractId: contract.id, code: `JS-${Date.now()}`, totalAmount: 500 } as any,
    });
    const res: any = await svc.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1);
    const declared = readWebTypeKeys('web/src/api/types/final-settlement.ts', 'FINAL_SETTLEMENT_ROW_KEYS');
    assertRowKeys(res.list[0], declared, '总结算单行');
    const asJson = JSON.parse(JSON.stringify(res.list[0]));
    assert.equal(typeof asJson.totalAmount, 'string', '总结算金额经 JSON 后应是 string（Prisma Decimal 原样）');
  });

  it('还款协议行字段集与声明一致（金额是 Decimal string）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-repayment');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000 });
    const svc = ctx.get<RepaymentService>(RepaymentService);
    await ctx.prisma.repaymentAgreement.create({
      data: {
        projectId: project.id,
        code: `HK-${Date.now()}`,
        supplierId: supplier.id,
        contractId: contract.id,
        settleAmount: 1000,
      } as any,
    });
    const res: any = await svc.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1);
    const declared = readWebTypeKeys('web/src/api/types/repayment.ts', 'REPAYMENT_ROW_KEYS');
    assertRowKeys(res.list[0], declared, '还款协议行');
    const asJson = JSON.parse(JSON.stringify(res.list[0]));
    assert.equal(typeof asJson.settleAmount, 'string', '还款金额经 JSON 后应是 string（Prisma Decimal 原样）');
  });
});
