import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, makeSupplier, uniq, type IntContext } from './helpers';
import { ContractService } from '../src/modules/contract/contract.service';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { ReceiptOrderService } from '../src/modules/receipt-order/receipt-order.service';
import { CONTRACT_EXECUTION_STATUS, CONTRACT_STATUS, SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · 合同归档（业务口径 2026-10-18：单向归档 + 下游写锁）。
 * 真库验的是：完整性检查是否接上、归档后合同/结算/收领单的写入口是否真的被 400 拦住。
 */
describe('集成 · 合同归档锁定', () => {
  let ctx: IntContext;
  let contracts: ContractService;
  let settle: SettlementService;
  let receipts: ReceiptOrderService;

  before(async () => {
    ctx = await bootIntApp();
    contracts = ctx.get<ContractService>(ContractService);
    settle = ctx.get<SettlementService>(SettlementService);
    receipts = ctx.get<ReceiptOrderService>(ReceiptOrderService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('未签章合同不能归档', async () => {
    const project = await makeProject(ctx.prisma, 'ARC-1');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 100, status: CONTRACT_STATUS.DRAFT });
    const check: any = await contracts.archiveCheck(contract.id, project.id);
    assert.equal(check.canArchive, false);
    assert.ok(check.blockers.some((b: string) => b.includes('尚未签章')));
    await assert.rejects(() => contracts.archive(contract.id, project.id, { username: 'tester' }), /尚未签章/);
  });

  it('下游收口的已签章合同可归档，归档后写操作全部 400、读取仍可用', async () => {
    const project = await makeProject(ctx.prisma, 'ARC-2');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 1000,
      status: CONTRACT_STATUS.SIGNED,
    });
    await ctx.prisma.contract.update({
      where: { id: contract.id },
      data: { execStatus: CONTRACT_EXECUTION_STATUS.DONE_SETTLED },
    });

    const check: any = await contracts.archiveCheck(contract.id, project.id);
    assert.equal(check.canArchive, true, JSON.stringify(check.blockers));
    const archived: any = await contracts.archive(contract.id, project.id, { userId: 'u1', username: 'tester' });
    assert.ok(archived.archivedAt);
    assert.equal(archived.archivedBy, 'tester');

    // 合同写操作被拦
    await assert.rejects(
      () => contracts.update(contract.id, { remark: 'x', version: archived.version }, null),
      /合同已归档/,
    );
    await assert.rejects(() => contracts.setStatus(contract.id, CONTRACT_STATUS.DRAFT), /合同已归档/);
    // 结算写操作被拦（新增）
    await assert.rejects(
      () =>
        settle.create(
          { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.DRAFT, amount: 10 },
          project.id,
        ),
      /合同已归档/,
    );
    // 收领单写操作被拦（新增）
    await assert.rejects(
      () =>
        receipts.create(
          {
            supplierId: supplier.id,
            supplierName: '归档测试供应商',
            supplierType: 'SUPPLIER',
            receivingUnitId: supplier.id,
            receivingUnitName: '本项目',
            receivingUnitType: 'SELF_PROJECT',
            materialContractId: contract.id,
            orderDate: new Date(2026, 8, 10),
          },
          project.id,
        ),
      /合同已归档/,
    );

    // 读取/详情仍可用
    const read: any = await contracts.findOne(contract.id);
    assert.equal(read.id, contract.id);
    assert.ok(read.archivedAt);

    // 单向：再次归档被拒
    await assert.rejects(() => contracts.archive(contract.id, project.id, { username: 'tester' }), /已归档/);
  });

  it('有草稿结算单时阻断，草稿删除后可归档', async () => {
    const project = await makeProject(ctx.prisma, 'ARC-3');
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      amount: 1000,
      status: CONTRACT_STATUS.SIGNED,
      name: uniq('归档草稿合同'),
    });
    const draft = await ctx.prisma.settlement.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        code: uniq('ARC-JS'),
        statusCode: SETTLEMENT_STATUS.DRAFT,
        amount: 100,
        settleDate: new Date(2026, 8, 30),
      },
    });
    const blocked: any = await contracts.archiveCheck(contract.id, project.id);
    assert.equal(blocked.canArchive, false);
    assert.ok(blocked.blockers.some((b: string) => b.includes('草稿结算单')));

    // 清掉草稿后（无下游）即可归档
    await ctx.prisma.settlement.delete({ where: { id: draft.id } });
    const ok: any = await contracts.archiveCheck(contract.id, project.id);
    assert.equal(ok.canArchive, true, JSON.stringify(ok.blockers));
  });
});
