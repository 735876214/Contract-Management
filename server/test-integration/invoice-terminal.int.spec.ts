import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, makeSupplier, uniq, type IntContext } from './helpers';
import { InvoiceService } from '../src/modules/invoice/invoice.service';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { ContractFulfillmentService } from '../src/modules/contract/contract-fulfillment.service';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { FieldResolverService } from '../src/modules/ai/field-resolver.service';
import { INVOICE_STATUS, SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · 发票作废（CANCELLED）/ 红冲（RED）联动（业务口径 2026-11-12）。
 *
 * 验的是真库口径：终态票不计入六处金额聚合（结算台账「本月开票额」、合同台账「开累发票金额」、
 * 履约开票比例、工作台累计开票额、AI 经营数据助手），**保留 settlementId 关联**；
 * 专用接口的状态合法性、通用 PUT 的收紧、空状态历史票仍计入。
 */
describe('集成 · 发票作废/红冲联动', () => {
  let ctx: IntContext;
  let invoices: InvoiceService;
  let settle: SettlementService;
  let ledger: LedgerService;
  let fulfillment: ContractFulfillmentService;
  let dashboard: DashboardService;
  let fieldResolver: FieldResolverService;

  before(async () => {
    ctx = await bootIntApp();
    invoices = ctx.get<InvoiceService>(InvoiceService);
    settle = ctx.get<SettlementService>(SettlementService);
    ledger = ctx.get<LedgerService>(LedgerService);
    fulfillment = ctx.get<ContractFulfillmentService>(ContractFulfillmentService);
    dashboard = ctx.get<DashboardService>(DashboardService);
    fieldResolver = ctx.get<FieldResolverService>(FieldResolverService);
  });
  after(async () => {
    await ctx.app.close();
  });

  const day = (m: number, d: number) => new Date(2026, m - 1, d);

  /** 建合同 + 9 月结算单，返回常用上下文 */
  const setupContract = async (tag: string, amount = 100000) => {
    const project = await makeProject(ctx.prisma, tag);
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount,
      status: 'SIGNED',
    });
    const settlement: any = await settle.create(
      {
        contractId: contract.id,
        typeCode: 'PROGRESS',
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 10000,
        settleDate: day(9, 30),
      },
      project.id,
    );
    return { project, contract, settlement };
  };

  const makeInvoice = (projectId: string, contractId: string, data: any = {}) =>
    invoices.create(
      {
        contractId,
        typeCode: 'VAT_SPECIAL',
        statusCode: INVOICE_STATUS.WAIT_VERIFY,
        settlePeriod: '2026-09',
        invoiceDate: day(8, 20),
        amountWithTax: 8800,
        invoiceNo: uniq('INV').toUpperCase(),
        ...data,
      },
      projectId,
    );

  const ledgerRow = (contractId: string, settleMonth: string) =>
    ctx.prisma.settlementLedger.findFirst({ where: { contractId, settleMonth } });

  it('① 作废：保留结算关联，六处金额口径全部排除', async () => {
    const { project, contract, settlement } = await setupContract('INV-CANCEL');
    const inv: any = await makeInvoice(project.id, contract.id);

    const linked = await ctx.prisma.invoice.findUnique({ where: { id: inv.id } });
    assert.equal(linked!.settlementId, settlement.id, '发票应自动挂到同合同同期的结算单上');

    // 作废前：台账「本月开票额」计入
    const before = await ledgerRow(contract.id, '2026-09');
    assert.equal(Number(before!.monthInvoiceAmount), 8800);

    await invoices.cancel(inv.id, project.id);

    const after = await ctx.prisma.invoice.findUnique({ where: { id: inv.id } });
    assert.equal(after!.statusCode, INVOICE_STATUS.CANCELLED);
    assert.equal(after!.settlementId, settlement.id, '作废必须**保留**结算单关联（审计可追溯）');

    // 结算台账「本月开票额」归 0
    const ledgerAfter = await ledgerRow(contract.id, '2026-09');
    assert.equal(Number(ledgerAfter!.monthInvoiceAmount), 0);

    // 合同台账「开累发票金额」归 0
    const list: any = await ledger.findAll({}, project.id);
    const rows = list.list ?? list;
    const row = rows.find((r: any) => r.id === contract.id);
    assert.equal(row.cumInvoiceAmount, 0);

    // 履约进度「已开票」归 0
    const ful: any = await fulfillment.get(contract.id, project.id);
    assert.equal(Number(ful.invoicedAmount), 0);

    // 工作台累计开票额归 0
    const ov: any = await dashboard.overview(project.id, {} as any);
    assert.equal(Number(ov.invoiceAmount), 0);

    // AI 经营数据助手「累计开票」归 0
    const stats = await fieldResolver.projectStats(project.id);
    assert.equal(Number(stats.invoiceAmountTotal), 0);
  });

  it('② 红冲：同一口径（状态 RED，金额全部排除）', async () => {
    const { project, contract } = await setupContract('INV-RED');
    const inv: any = await makeInvoice(project.id, contract.id, { amountWithTax: 500 });

    const before = await ledgerRow(contract.id, '2026-09');
    assert.equal(Number(before!.monthInvoiceAmount), 500);

    await invoices.red(inv.id, project.id);

    const after = await ctx.prisma.invoice.findUnique({ where: { id: inv.id } });
    assert.equal(after!.statusCode, INVOICE_STATUS.RED);
    const ledgerAfter = await ledgerRow(contract.id, '2026-09');
    assert.equal(Number(ledgerAfter!.monthInvoiceAmount), 0);
    const ful: any = await fulfillment.get(contract.id, project.id);
    assert.equal(Number(ful.invoicedAmount), 0);
  });

  it('③ 终态不可重复、不可互转', async () => {
    const { project, contract } = await setupContract('INV-TERM');
    const cancelled: any = await makeInvoice(project.id, contract.id);
    await invoices.cancel(cancelled.id, project.id);

    await assert.rejects(() => invoices.cancel(cancelled.id, project.id), /已作废，不能重复作废/);
    await assert.rejects(() => invoices.red(cancelled.id, project.id), /已处于终态/);

    const red: any = await makeInvoice(project.id, contract.id);
    await invoices.red(red.id, project.id);
    await assert.rejects(() => invoices.red(red.id, project.id), /已红冲，不能重复红冲/);
  });

  it('④ 通用 PUT 不允许状态进出终态；终态整包回传原值可改其它字段', async () => {
    const { project, contract } = await setupContract('INV-PUT');
    const inv: any = await makeInvoice(project.id, contract.id);

    await assert.rejects(
      () => invoices.update(inv.id, { statusCode: INVOICE_STATUS.CANCELLED, version: inv.version }, project.id),
      /专用操作/,
    );

    await invoices.red(inv.id, project.id);
    const redRow = await ctx.prisma.invoice.findUnique({ where: { id: inv.id } });

    await assert.rejects(
      () => invoices.update(inv.id, { statusCode: INVOICE_STATUS.VERIFIED, version: redRow!.version }, project.id),
      /终态/,
    );

    // 终态 + 原值回传 + 改备注：放行（前端编辑表单会整包回传 statusCode）
    const ok: any = await invoices.update(
      inv.id,
      { statusCode: INVOICE_STATUS.RED, remark: '红冲备注', version: redRow!.version },
      project.id,
    );
    assert.equal(ok.remark, '红冲备注');
    assert.equal(ok.statusCode, INVOICE_STATUS.RED);
  });

  it('⑤ 终态发票不能查验', async () => {
    const { project, contract } = await setupContract('INV-VERIFY');
    const inv: any = await makeInvoice(project.id, contract.id);
    await invoices.cancel(inv.id, project.id);
    await assert.rejects(() => invoices.verify(inv.id, project.id), /不能查验/);
  });

  it('⑥ 跨项目调用作废/红冲 → 发票不存在（404）', async () => {
    const { project, contract } = await setupContract('INV-SCOPE-A');
    const inv: any = await makeInvoice(project.id, contract.id);
    const other = await makeProject(ctx.prisma, 'INV-SCOPE-B');

    await assert.rejects(() => invoices.cancel(inv.id, other.id), /发票不存在/);
    await assert.rejects(() => invoices.red(inv.id, other.id), /发票不存在/);
  });

  it('⑦ 空状态（NULL）历史发票仍计入金额口径', async () => {
    const { project, contract } = await setupContract('INV-NULL');
    await ctx.prisma.invoice.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        typeCode: 'VAT_SPECIAL',
        statusCode: null,
        settlePeriod: '2026-10',
        invoiceDate: day(10, 10),
        amountWithTax: 123,
        invoiceNo: uniq('INV-NULL').toUpperCase(),
      } as any,
    });
    await settle.refreshLedger(project.id);
    const row = await ledgerRow(contract.id, '2026-10');
    assert.ok(row, '空状态发票仍应参与台账月份生成');
    assert.equal(Number(row!.monthInvoiceAmount), 123);
  });

  it('⑧ 终态孤儿发票不生成「幽灵台账行」', async () => {
    const { project, contract } = await setupContract('INV-GHOST');
    await ctx.prisma.invoice.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        typeCode: 'VAT_SPECIAL',
        statusCode: INVOICE_STATUS.CANCELLED,
        settlePeriod: '2026-11',
        invoiceDate: day(11, 10),
        amountWithTax: 999,
        invoiceNo: uniq('INV-GHOST').toUpperCase(),
      } as any,
    });
    await settle.refreshLedger(project.id);
    const row = await ledgerRow(contract.id, '2026-11');
    assert.equal(row, null, '作废发票不应单独造出一条 0 金额台账行');
  });

  it('⑨ 工作台：按类型金额只算有效票，状态分布仍包含终态计数', async () => {
    const { project, contract } = await setupContract('INV-STATS');
    const okInv: any = await makeInvoice(project.id, contract.id, { amountWithTax: 100 });
    const cancelled: any = await makeInvoice(project.id, contract.id, { amountWithTax: 700 });
    const red: any = await makeInvoice(project.id, contract.id, { amountWithTax: 900 });
    await invoices.cancel(cancelled.id, project.id);
    await invoices.red(red.id, project.id);
    assert.ok(okInv.id);

    const stats: any = await dashboard.invoiceStats(project.id);
    const typeRow = stats.byType.find((r: any) => r.typeCode === 'VAT_SPECIAL');
    assert.equal(Number(typeRow.amount), 100, 'byType 金额只统计有效发票');
    const cancelledCount = stats.byStatus.find((r: any) => r.statusCode === INVOICE_STATUS.CANCELLED)?.count ?? 0;
    const redCount = stats.byStatus.find((r: any) => r.statusCode === INVOICE_STATUS.RED)?.count ?? 0;
    assert.ok(cancelledCount >= 1 && redCount >= 1, '状态分布要能看到作废/红冲张数');
  });
});
