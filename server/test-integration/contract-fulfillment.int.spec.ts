import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, makeSupplier, uniq, type IntContext } from './helpers';
import { ContractFulfillmentService } from '../src/modules/contract/contract-fulfillment.service';
import { SETTLEMENT_STATUS, PAYMENT_STATUS, SITE_CONFIRM_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · 合同履约派生进度（业务口径 2026-10-18：零表派生）。
 * 验的是真库取数口径：合同链金额、总日报已收、结算排除草稿、付款排除失败/退款、发票合计。
 */
describe('集成 · 合同履约派生进度', () => {
  let ctx: IntContext;
  let service: ContractFulfillmentService;

  before(async () => {
    ctx = await bootIntApp();
    service = ctx.get<ContractFulfillmentService>(ContractFulfillmentService);
  });
  after(async () => {
    await ctx.app.close();
  });

  const day = (m: number, d: number) => new Date(2026, m - 1, d);

  it('按合同链汇总：已收/已结/已付/开票比例与剩余量', async () => {
    const project = await makeProject(ctx.prisma, 'FUL-1');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 1000,
      status: 'SIGNED',
    });
    const material = await ctx.prisma.materialBase.create({
      data: { name: uniq('FUL-MAT'), spec: uniq('FUL-SPEC'), unit: '吨' },
    });
    await ctx.prisma.contractMaterial.create({
      data: { contractId: contract.id, materialBaseId: material.id, unit: '吨', qty: 100 },
    });

    // 主合同 + 补充协议（+100）→ 当前金额 1100
    await makeContract(ctx.prisma, {
      projectId: project.id,
      code: uniq('FUL-SUP').toUpperCase(),
      isSupplement: 'Y',
      parentContractId: contract.id,
      changeAmount: 100,
    });

    await ctx.prisma.dailyReport.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        materialBaseId: material.id,
        entryDate: day(9, 10),
        settleQty: 40,
        confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED,
      },
    });
    await ctx.prisma.dailyReport.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        materialBaseId: material.id,
        entryDate: day(9, 11),
        settleQty: 9,
        confirmStatusCode: SITE_CONFIRM_STATUS.PENDING,
      },
    });
    await ctx.prisma.settlement.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        code: uniq('FUL-JS'),
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 300,
        actualAmount: 300,
        settleDate: day(9, 30),
      },
    });
    // 草稿结算不计入
    await ctx.prisma.settlement.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        code: uniq('FUL-JS-DRAFT'),
        statusCode: SETTLEMENT_STATUS.DRAFT,
        amount: 999,
        actualAmount: 999,
        settleDate: day(10, 31),
      },
    });
    await ctx.prisma.paymentRecord.create({
      data: { projectId: project.id, contractId: contract.id, amount: 200, statusCode: PAYMENT_STATUS.PAID },
    });
    // 失败付款不计入
    await ctx.prisma.paymentRecord.create({
      data: { projectId: project.id, contractId: contract.id, amount: 50, statusCode: PAYMENT_STATUS.FAILED },
    });
    await ctx.prisma.invoice.create({
      data: { projectId: project.id, contractId: contract.id, amountWithTax: 150 },
    });

    const r: any = await service.get(contract.id, project.id);
    assert.equal(r.currentAmount, 1100, '合同当前金额 = 主合同 + 补充协议增量');
    assert.equal(r.orderedQty, 100);
    assert.equal(r.receivedQty, 40, '只算已确认日报行');
    assert.equal(r.settledAmount, 300, '草稿结算不计入');
    assert.equal(r.paidAmount, 200, '失败付款不计入');
    assert.equal(r.invoicedAmount, 150);
    assert.equal(r.receivedRatio, 0.4);
    assert.equal(r.settledRatio, Number((300 / 1100).toFixed(4)));
    assert.equal(r.paidVsSettledRatio, Number((200 / 300).toFixed(4)));
    assert.equal(r.remainingToReceiveQty, 60);
    assert.equal(r.remainingToSettleAmount, 800);
    assert.equal(r.unpaidAmount, 100);
  });

  it('跨项目不可见（404）', async () => {
    const p1 = await makeProject(ctx.prisma, 'FUL-2A');
    const p2 = await makeProject(ctx.prisma, 'FUL-2B');
    const contract = await makeContract(ctx.prisma, { projectId: p1.id, amount: 100 });
    await assert.rejects(() => service.get(contract.id, p2.id), /合同不存在/);
  });
});
