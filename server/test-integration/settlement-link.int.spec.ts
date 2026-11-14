import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeSupplier, type IntContext } from './helpers';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · **结算台账与结算单的关联**（业务口径 2026-10-16）。
 *
 * 纯函数单测证明不了"闸门是否真的接上了"，这里在真库上验：
 * ① 结算单保存 → 台账行**自动生成**并挂上 `settlementId`（改造前全仓无人调 `syncLedgerByContract`，
 *    台账只能手动刷新 —— 这正是"看不出关联"的根因）；
 * ② **同合同同月第二张结算单被 400 拦住**（台账 1:1 的前提）；
 * ③ 改月份 / 删结算单 → 台账行的关联被解除并退回"仅费用行"形态；
 * ④ 台账的 `factoringDiscount` / `overdueInterest` 是**只读派生列**，写入一律 400；
 * ⑤ 无结算单、只有资金费用时，台账行照样生成（`settlementId = null`）。
 */
describe('集成 · 结算台账 ↔ 结算单关联', () => {
  let ctx: IntContext;
  let settle: SettlementService;

  const month = (y: number, m: number) => new Date(y, m - 1, 15);

  before(async () => {
    ctx = await bootIntApp();
    settle = ctx.get<SettlementService>(SettlementService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('① 结算单保存后台账行自动生成并挂上 settlementId（不需要手动刷新）', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-1');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 30000, settleDate: month(2026, 3) },
      project.id,
    );

    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-03' } });
    assert.ok(row, '结算单保存后应自动出现对应月份的台账行');
    assert.equal(row!.settlementId, s.id, '台账行必须挂上这张结算单');
    assert.equal(Number(row!.monthSettleAmount), 30000);
    assert.equal(row!.settleCount, 1, '同月唯一 → 结算张数为 1');
  });

  it('② 同合同同月第二张结算单被 400 拦住（并提示已有单号）', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-2');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const first: any = await settle.create(
      { contractId: contract.id, code: 'JS-2026-09-A', typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 10000, settleDate: month(2026, 9) },
      project.id,
    );
    assert.ok(first?.id);

    await assert.rejects(
      () =>
        settle.create(
          { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 20000, settleDate: month(2026, 9) },
          project.id,
        ),
      (e: any) => e instanceof BadRequestException && /2026-09/.test(e.message) && /只允许一张/.test(e.message),
      '同月第二张应被拦住，而不是静默合并进同一行台账',
    );

    // 换一个月则允许
    const other: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 20000, settleDate: month(2026, 10) },
      project.id,
    );
    assert.ok(other?.id, '换月份应当可以建第二张');
    assert.equal(await ctx.prisma.settlementLedger.count({ where: { contractId: contract.id } }), 2, '两个月 → 两行台账');
  });

  it('③ 改月份 → 旧月行退回「仅费用行」，新月行建立', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-3');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 5000, settleDate: month(2026, 4) },
      project.id,
    );
    await settle.update(s.id, { settleDate: month(2026, 5), version: 0 });

    const oldRow = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-04' } });
    assert.ok(oldRow, '旧月份的台账行要保留（可能还有资金费用/发票）');
    assert.equal(oldRow!.settlementId, null, '关联必须解除');
    assert.equal(Number(oldRow!.monthSettleAmount), 0, '结算额随之归零');

    const newRow = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-05' } });
    assert.equal(newRow?.settlementId, s.id, '新月份应挂上该结算单');
  });

  it('④ 删结算单 → 台账行保留、关联解除、金额归零', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-4');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 8000, settleDate: month(2026, 6) },
      project.id,
    );
    await settle.remove(s.id);

    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-06' } });
    assert.ok(row, '台账行不随结算单物理删除（它可能承载发票/资金费用）');
    assert.equal(row!.settlementId, null);
    assert.equal(Number(row!.monthSettleAmount), 0);
    assert.equal(row!.settleCount, 0);
  });

  it('⑤ 只有资金费用、没有结算单时，台账行照样生成（settlementId 为空）', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-5');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    await ctx.prisma.factoringCost.create({
      data: { contractId: contract.id, settlementMonth: '2026-07', financingInterest: 500, handlingFee: 100, totalCost: 600 },
    });

    await settle.refreshLedger(project.id);

    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-07' } });
    assert.ok(row, '当月无结算但有资金费用 → 台账行仍要生成');
    assert.equal(row!.settlementId, null, '此时没有对应结算单');
    assert.equal(Number(row!.monthSettleAmount), 0, '结算额为 0，而不是空/未生成');
    assert.equal(Number(row!.factoringDiscount), 600, '资金费用按台账口径抓取');
  });

  it('⑥ 台账的「保理贴息 / 逾期利息」是只读派生列：写入一律 400', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-6');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const row = await ctx.prisma.settlementLedger.create({
      data: { projectId: project.id, contractId: contract.id, settleMonth: '2026-08' },
    });

    for (const field of ['factoringDiscount', 'overdueInterest'] as const) {
      await assert.rejects(
        () => settle.updateLedger(row.id, { [field]: 1234, version: 0 }),
        (e: any) => e instanceof BadRequestException && /只读/.test(e.message),
        `${field} 应被明确拒绝（而不是静默忽略）`,
      );
    }

    // 其它可写字段照常
    const updated: any = await settle.updateLedger(row.id, { isOnAccount: 'Y', version: 0 });
    assert.equal(updated?.isOnAccount, 'Y', '可写字段不受影响');
  });

  it('⑦ 只改备注不清空手填的「本月开票额」；改月份才按系统值重算', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-7');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    // 无发票的月份：手填的本月开票额应被保留（与 createLedger 的「只补空值」口径一致）
    const row: any = await settle.createLedger(
      { contractId: contract.id, settleMonth: '2026-07', monthInvoiceAmount: 5000 },
      project.id,
    );
    assert.equal(Number(row.monthInvoiceAmount), 5000, '系统算不出开票额时应保留手填值');

    // 前端编辑表单会把 disabled 字段的值一起提交：只改备注不得把开票额抹成 0
    const remarkOnly: any = await settle.updateLedger(
      row.id,
      { version: row.version, remark: '只改备注', monthInvoiceAmount: 5000 },
      project.id,
    );
    assert.equal(Number(remarkOnly.monthInvoiceAmount), 5000, '只改备注不得清除手填的开票额');

    // 换月份后旧月份的手填值不再适用：按新月份的系统值重算（该月无发票 → 0）
    const moved: any = await settle.updateLedger(
      row.id,
      { version: remarkOnly.version, settleMonth: '2026-08', monthInvoiceAmount: 5000, remark: '换月' },
      project.id,
    );
    assert.equal(moved.settleMonth, '2026-08');
    assert.equal(Number(moved.monthInvoiceAmount), 0, '改月份后按新月份重算，不沿用旧月手填值');
  });

  it('⑧ 结算单换合同 → 旧合同发票解绑，两边台账开票额不串账', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-8');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const a = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const b = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: a.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 8000, settleDate: month(2026, 6) },
      project.id,
    );
    // 模拟已按「合同 + 月份」自动挂到该结算单的发票
    const inv = await ctx.prisma.invoice.create({
      data: {
        projectId: project.id,
        contractId: a.id,
        settlementId: s.id,
        settlePeriod: '2026-06',
        amountWithTax: 5000,
        statusCode: 'VERIFIED',
      },
    });

    await settle.update(s.id, { contractId: b.id, version: 0 });

    const moved = await ctx.prisma.invoice.findUnique({ where: { id: inv.id } });
    assert.equal(moved!.settlementId, null, '换合同后旧合同的发票必须解绑');

    const rowA = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: a.id, settleMonth: '2026-06' } });
    const rowB = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: b.id, settleMonth: '2026-06' } });
    assert.equal(Number(rowB!.monthInvoiceAmount), 0, '新合同台账不得凭空多出旧合同的开票额');
    assert.equal(Number(rowA!.monthInvoiceAmount), 5000, '旧合同按「合同 + 月份」回退归集，开票额不丢');
  });

  it('⑨ 结算单换合同 → 旧合同的收领单同样解绑', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-9');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const a = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const b = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: a.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 8000, settleDate: month(2026, 6) },
      project.id,
    );
    const ro = await ctx.prisma.receiptOrder.create({
      data: {
        projectId: project.id,
        orderNo: `LINK-RO-${Date.now()}`,
        materialContractId: a.id,
        settlementId: s.id,
        orderDate: month(2026, 6),
        status: 'SAVED',
      } as any,
    });

    await settle.update(s.id, { contractId: b.id, version: 0 });

    const moved = await ctx.prisma.receiptOrder.findUnique({ where: { id: ro.id } });
    assert.equal(moved!.settlementId, null, '换合同后旧合同的收领单必须解绑（与发票同口径）');
  });

  it('⑩ 未挂合同的发票/收领单：已挂本行时仍计入/保持关联（不能被合同过滤静默漏掉）', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-10');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 8000, settleDate: month(2026, 7) },
      project.id,
    );
    // 手工/历史发票：没有 contractId，但已挂到本合同的结算单（assertLinkable 在合同为空时放行）
    const inv = await ctx.prisma.invoice.create({
      data: {
        projectId: project.id,
        contractId: null,
        settlementId: s.id,
        settlePeriod: '2026-07',
        amountWithTax: 3000,
        statusCode: 'VERIFIED',
      },
    });
    // 手工/历史收领单：materialContractId 为空但已挂本行
    const ro = await ctx.prisma.receiptOrder.create({
      data: {
        projectId: project.id,
        orderNo: `LINK-RO-EMPTY-${Date.now()}`,
        materialContractId: null,
        settlementId: s.id,
        orderDate: month(2026, 7),
        status: 'SAVED',
      } as any,
    });

    await settle.syncLedgerByContract(contract.id);

    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-07' } });
    assert.equal(Number(row!.monthInvoiceAmount), 3000, '无合同发票挂在结算单上时仍计入「本月开票额」');
    assert.equal(
      (await ctx.prisma.invoice.findUnique({ where: { id: inv.id } }))!.settlementId,
      s.id,
      '无合同发票的已有关联不能被本合同刷新误解绑',
    );
    assert.equal(
      (await ctx.prisma.receiptOrder.findUnique({ where: { id: ro.id } }))!.settlementId,
      s.id,
      '无合同收领单的已有关联不能被本合同刷新误解绑',
    );
  });
});
