import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, makeSupplier, type IntContext } from './helpers';
import { LedgerService } from '../src/modules/ledger';
import { SETTLEMENT_STATUS, INVOICE_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · 合同台账的派生金额口径（真库）。
 *
 * 纯函数单测（`ledgerDerived.spec.mts`）证明算式本身；这里证明 **service 真的接上了**：
 * ① 项目「合同额」合计按**链**只计一次（补充协议行的自由 `amount` 不参与相加）；
 * ② 「审定结算额」排除草稿、`actualAmount` 为空时回退 `amount`；
 * ③ 「开累发票税前金额 / 进项税额」由**有效发票**逐张派生（业务口径 2026-11-18）：
 *    作废/红冲不计入、缺税前时可反推、无票为 0、有票算不出为 null。
 */
describe('集成 · 台账派生金额口径', () => {
  let ctx: IntContext;
  let ledger: LedgerService;

  before(async () => {
    ctx = await bootIntApp();
    ledger = ctx.get<LedgerService>(LedgerService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('合同额合计按链只计一次：补充协议的自由 amount 不再相加', async () => {
    const project = await makeProject(ctx.prisma, 'LEDGER-1');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const main = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 1000000,
    });
    await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 200000,
      isSupplement: 'Y',
      parentContractId: main.id,
      changeAmount: 50000,
    });

    const summary: any = await ledger.summary(project.id);
    assert.equal(
      summary.contractAmount,
      1050000,
      '主合同 100 万 + 增量 5 万；补充协议的 20 万是自由值，逐行相加会重复计入',
    );
  });

  it('审定结算额排除草稿，并在 actualAmount 为空时回退 amount', async () => {
    const project = await makeProject(ctx.prisma, 'LEDGER-2');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 1000000,
    });
    const base = { projectId: project.id, contractId: contract.id };
    await ctx.prisma.settlement.create({
      data: { ...base, statusCode: SETTLEMENT_STATUS.DRAFT, actualAmount: 300000, settleDate: new Date(2026, 8, 15) },
    });
    await ctx.prisma.settlement.create({
      data: {
        ...base,
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 120000,
        deductAmount: 20000,
        actualAmount: 100000,
        settleDate: new Date(2026, 7, 15),
      },
    });
    // 历史行：actualAmount 为空、amount 有值 → 回退 amount（与 chainSettledTotal 同口径）
    await ctx.prisma.settlement.create({
      data: {
        ...base,
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 50000,
        actualAmount: null,
        settleDate: new Date(2026, 6, 15),
      },
    });

    const res: any = await ledger.findAll({}, project.id);
    const row = res.list.find((r: any) => r.id === contract.id);
    assert.equal(row.auditedSettleAmount, 150000, '草稿 30 万不计入；已确认 10 万 + 历史 5 万 = 15 万');
    assert.equal(
      row.settleReduceAmount,
      20000,
      '审减额 = 送审（12 万 + 5 万）− 审定（10 万 + 5 万）= 2 万；不能拿含草稿的开累相减',
    );
  });

  it('开累发票税前金额/进项税额由发票逐张派生（无票→0，有票算不出→null）', async () => {
    const project = await makeProject(ctx.prisma, 'LEDGER-3');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const noInvoice = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000000 });
    const withInvoices = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000000 });
    const broken = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000000 });

    const inv = (contractId: string, data: any) =>
      ctx.prisma.invoice.create({
        data: { projectId: project.id, contractId, typeCode: 'VAT_SPECIAL', statusCode: INVOICE_STATUS.WAIT_VERIFY, ...data },
      });

    // 票面税前齐全
    await inv(withInvoices.id, { invoiceNo: 'INV-T-1', amountBeforeTax: 100000, taxRatePct: 13, amountWithTax: 113000 });
    // 票面税前缺、只有含税+税率 → 反推税前 10 万、进项 0.9 万
    await inv(withInvoices.id, { invoiceNo: 'INV-T-2', amountBeforeTax: null, taxRatePct: 9, amountWithTax: 109000 });
    // 作废票不计入（若计入，税前会多 50 万）
    await inv(withInvoices.id, {
      invoiceNo: 'INV-T-3',
      amountBeforeTax: 500000,
      taxRatePct: 13,
      amountWithTax: 565000,
      statusCode: INVOICE_STATUS.CANCELLED,
    });
    // 有票但金额全缺 → 两列是"未知"（null），不是 0
    await inv(broken.id, { invoiceNo: 'INV-T-4', amountBeforeTax: null, taxRatePct: null, amountWithTax: null });

    const res: any = await ledger.findAll({}, project.id);
    const row = (id: string) => res.list.find((r: any) => r.id === id);

    const a = row(withInvoices.id);
    assert.equal(a.cumSettleBeforeTax, 200000, '10 万 + 反推 10 万；作废票不计入');
    assert.equal(a.cumInputTax, 22000, '1.3 万 + 0.9 万，均按逐张 含税−税前');
    assert.equal(a.cumInvoiceAmount, 222000, '开累发票金额同样只含有效票');

    const b = row(noInvoice.id);
    assert.equal(b.cumSettleBeforeTax, 0, '没开票就是 0（不是未知）');
    assert.equal(b.cumInputTax, 0);

    const c = row(broken.id);
    assert.equal(c.cumSettleBeforeTax, null, '有票但税额算不出 → null（未知不兜 0）');
    assert.equal(c.cumInputTax, null);
  });

  it('100% 欠款 = 审定结算额(总结算书 SETTLED) − 已付款；无已定案总结算书退回开累结算额', async () => {
    const project = await makeProject(ctx.prisma, 'LEDGER-4');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const withFinal = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const noFinal = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const pending = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const ledgerRow = (contractId: string) =>
      ctx.prisma.settlementLedger.create({ data: { projectId: project.id, contractId, settleMonth: '2026-03', monthSettleAmount: 60000 } });
    await ledgerRow(withFinal.id);
    await ledgerRow(noFinal.id);
    await ledgerRow(pending.id);

    const pay = (contractId: string) =>
      ctx.prisma.paymentRecord.create({ data: { projectId: project.id, contractId, payMonth: '2026-04', amount: 20000, statusCode: 'PAID' } });
    await pay(withFinal.id);
    await pay(noFinal.id);
    await pay(pending.id);

    const fs = (contractId: string, statusCode: string, totalAmount: number) =>
      ctx.prisma.finalSettlement.create({ data: { projectId: project.id, contractId, statusCode, totalAmount } });
    await fs(withFinal.id, 'SETTLED', 200000);
    // 未定案（待补附件）的快照金额不得进入欠款基数
    await fs(pending.id, 'PENDING_ATTACHMENT', 999999);

    const res: any = await ledger.findAll({}, project.id);
    const row = (id: string) => res.list.find((r: any) => r.id === id);

    assert.equal(row(withFinal.id).debt100, 180000, '已定案总结算书 20 万 − 已付 2 万');
    assert.equal(row(noFinal.id).debt100, 40000, '无总结算书 → 开累结算 6 万 − 已付 2 万');
    assert.equal(row(pending.id).debt100, 40000, 'PENDING_ATTACHMENT 快照不计入 → 退回开累结算 6 万 − 已付 2 万');
  });
});
