import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeSupplier, type IntContext } from './helpers';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { InvoiceService } from '../src/modules/invoice';
import { ProjectService } from '../src/modules/project/project.service';
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
  let invoices: InvoiceService;
  let projects: ProjectService;

  const month = (y: number, m: number) => new Date(y, m - 1, 15);

  before(async () => {
    ctx = await bootIntApp();
    settle = ctx.get<SettlementService>(SettlementService);
    invoices = ctx.get<InvoiceService>(InvoiceService);
    projects = ctx.get<ProjectService>(ProjectService);
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

  it('③ 改月份 → 旧月行保留（承载资金费用）、关联解除，新月行建立', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-3');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 5000, settleDate: month(2026, 4) },
      project.id,
    );
    // 旧月份还有资金费用 → 不是「纯自动空行」，剪除时必须保留
    await ctx.prisma.factoringCost.create({
      data: { contractId: contract.id, settlementMonth: '2026-04', financingInterest: 500, handlingFee: 100, totalCost: 600 },
    });
    await settle.update(s.id, { settleDate: month(2026, 5), version: 0 });

    const oldRow = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-04' } });
    assert.ok(oldRow, '旧月份仍承载资金费用，台账行要保留');
    assert.equal(oldRow!.settlementId, null, '关联必须解除');
    assert.equal(Number(oldRow!.monthSettleAmount), 0, '结算额随之归零');
    assert.equal(Number(oldRow!.factoringDiscount), 600, '资金费用仍在');

    const newRow = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-05' } });
    assert.equal(newRow?.settlementId, s.id, '新月份应挂上该结算单');
  });

  it('④ 删结算单 → 承载资金费用的台账行保留、关联解除、结算额归零', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-4');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 8000, settleDate: month(2026, 6) },
      project.id,
    );
    await ctx.prisma.factoringCost.create({
      data: { contractId: contract.id, settlementMonth: '2026-06', financingInterest: 500, handlingFee: 100, totalCost: 600 },
    });
    await settle.remove(s.id);

    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-06' } });
    assert.ok(row, '台账行不随结算单物理删除（它承载资金费用）');
    assert.equal(row!.settlementId, null);
    assert.equal(Number(row!.monthSettleAmount), 0);
    assert.equal(row!.settleCount, 0);
    assert.equal(Number(row!.factoringDiscount), 600);
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

    for (const field of [
      'factoringDiscount',
      'overdueInterest',
      'monthSettleAmount',
      'settleCount',
      'yearSettleAmount',
      'cumPurchaseAmount',
      'startSettleAmount',
      'monthActualPurchase',
    ] as const) {
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
    // 手工/历史发票：没有 contractId，但已挂到本合同的结算单
    // （历史数据早于严格的同合同校验；新关联现在要求合同完全一致）
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

  it('⑪ 已关联结算单的台账行不能删；仅费用行可删', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-9');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 10000, settleDate: month(2026, 5) },
      project.id,
    );
    const row = await ctx.prisma.settlementLedger.findFirst({ where: { settlementId: s.id } });
    assert.ok(row, '结算单保存后应生成对应台账行');
    await assert.rejects(
      () => settle.removeLedger(row!.id, project.id),
      (e: any) => e instanceof BadRequestException && /不能直接删除/.test(e.message),
      '有结算单的台账行直接删除会打断 1:1，必须 400',
    );

    // 仅费用行（无结算单）仍可手工删除
    const fee: any = await settle.createLedger(
      { contractId: contract.id, settleMonth: '2026-04', monthInvoiceAmount: 0 },
      project.id,
    );
    assert.equal(fee.settlementId, null, '该月没有结算单 → 应为仅费用行');
    await settle.removeLedger(fee.id, project.id);
    const gone = await ctx.prisma.settlementLedger.findFirst({ where: { id: fee.id } });
    assert.equal(gone, null);
  });

  it('⑫ 合同归属必须完全一致：无合同结算单不能挂有合同单据，反之亦然', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-10');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const noContract: any = await settle.create(
      { typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 1000, settleDate: month(2026, 5) },
      project.id,
    );
    await assert.rejects(
      () => settle.assertLinkable(noContract.id, project.id, { contractId: contract.id, date: month(2026, 5), label: '发票' }),
      (e: any) => e instanceof BadRequestException && /不属于本发票的合同/.test(e.message),
    );
    // 两边都没有合同 → 允许
    const ok = await settle.assertLinkable(noContract.id, project.id, { contractId: null, date: month(2026, 5), label: '发票' });
    assert.equal(ok.id, noContract.id);

    // 反向：有合同的结算单不能挂无合同单据
    const withContract: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 2000, settleDate: month(2026, 6) },
      project.id,
    );
    await assert.rejects(
      () => settle.assertLinkable(withContract.id, project.id, { contractId: null, date: month(2026, 6), label: '收领单' }),
      (e: any) => e instanceof BadRequestException && /不属于本收领单的合同/.test(e.message),
    );
  });

  it('⑬ 新建结算单不传状态 → 落草稿（不再产生会让闸门与累计口径打架的 NULL）', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-11');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const a: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', amount: 1000, settleDate: month(2026, 3) },
      project.id,
    );
    assert.equal(a.statusCode, SETTLEMENT_STATUS.DRAFT, '缺省状态应落草稿');
    const b: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: null, amount: 2000, settleDate: month(2026, 4) },
      project.id,
    );
    assert.equal(b.statusCode, SETTLEMENT_STATUS.DRAFT, '显式 null 也不落 NULL');
  });

  it('⑭ 归档后台账不可写；已挂结算单的台账行不能改合同/月份', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-12');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const other = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 10000, settleDate: month(2026, 5) },
      project.id,
    );
    const row = await ctx.prisma.settlementLedger.findFirst({ where: { settlementId: s.id } });
    assert.ok(row);
    await assert.rejects(
      () => settle.updateLedger(row!.id, { contractId: other.id, version: row!.version }, project.id),
      (e: any) => e instanceof BadRequestException && /不能改合同或结算月份/.test(e.message),
      '搬走已挂单的行会打断 1:1',
    );

    await ctx.prisma.contract.update({ where: { id: contract.id }, data: { archivedAt: new Date() } });
    await assert.rejects(
      () => settle.createLedger({ contractId: contract.id, settleMonth: '2026-03' }, project.id),
      /合同已归档/,
      '归档后台账仍可新增就是写锁缺口',
    );
  });

  it('⑮ 历史无合同发票（已挂合同结算单）编辑时保持关联、不再 400', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-13');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 5000, settleDate: month(2026, 6) },
      project.id,
    );
    const inv = await ctx.prisma.invoice.create({
      data: {
        projectId: project.id,
        contractId: null,
        settlementId: s.id,
        settlePeriod: '2026-06',
        amountWithTax: 3000,
        statusCode: 'VERIFIED',
      },
    });

    const updated: any = await invoices.update(inv.id, { settlementId: s.id, remark: '改备注', version: 0 }, project.id);
    assert.equal(updated.settlementId, s.id, '关联没动就不该重新校验，否则整张发票存不了');
  });

  it('⑯ 同期历史多张结算单时，自动匹配与台账选同一张（最新 settleDate）', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-14');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    // 直接落库制造历史同期重复（服务层已禁止新写入）
    await ctx.prisma.settlement.create({
      data: { projectId: project.id, contractId: contract.id, statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 1000, settleDate: new Date(2026, 4, 10) },
    });
    const newer = await ctx.prisma.settlement.create({
      data: { projectId: project.id, contractId: contract.id, statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 2000, settleDate: new Date(2026, 4, 20) },
    });

    const id = await settle.findSettlementIdFor(contract.id, month(2026, 5));
    assert.equal(id, newer.id, '必须与 computeLedgerAutoFields 的 settleDate desc 选择一致');
  });

  it('⑰ 项目已有结算单时，不能改结算起始日（期归属会整体漂移）', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-15');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    await ctx.prisma.settlement.create({
      data: { projectId: project.id, contractId: contract.id, statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 1000, settleDate: month(2026, 1) },
    });
    await assert.rejects(
      () =>
        projects.update(
          project.id,
          { settlementStartDate: '2026-01-26', version: (project as any).version },
          { userId: 'tester', isSuperAdmin: true },
        ),
      /结算起始日/,
    );
  });

  it('⑱ 只由发票撑起的月份：发票作废后空台账行被剪除（不留 0 元幽灵行）', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-16');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const inv = await ctx.prisma.invoice.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        settlePeriod: '2026-08',
        amountWithTax: 4000,
        statusCode: 'VERIFIED',
      },
    });
    await settle.refreshLedger(project.id);
    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-08' } });
    assert.ok(row, '发票月份应生成台账行');
    assert.equal(Number(row!.monthInvoiceAmount), 4000);

    await ctx.prisma.invoice.update({ where: { id: inv.id }, data: { statusCode: 'CANCELLED' } });
    await settle.syncLedgerByContract(contract.id);

    const after = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-08' } });
    assert.equal(after, null, '纯发票驱动的空行应被剪除，与「先作废再刷新不会建行」保持同一种库形');
  });

  it('⑲ 开累采购额/开工结算额/当月实际采购额/本年结算额 按结算单自动派生', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-17');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const mk = (amount: number, y: number, m: number) =>
      settle.create(
        { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount, settleDate: month(y, m) },
        project.id,
      );
    await mk(5000, 2025, 12);
    await mk(10000, 2026, 1);
    await mk(20000, 2026, 2);
    await mk(15000, 2026, 3);

    const row = (mm: string) =>
      ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: mm } });

    // 开工结算额 = 全部结算期合计 50000，对每一行恒定
    for (const mm of ['2025-12', '2026-01', '2026-02', '2026-03']) {
      assert.equal(Number((await row(mm))!.startSettleAmount), 50000, `${mm} 开工结算额应为合同累计 50000`);
    }
    // 截止当月开累采购额 = Σ 结算期 ≤ 本月
    assert.equal(Number((await row('2025-12'))!.cumPurchaseAmount), 5000);
    assert.equal(Number((await row('2026-01'))!.cumPurchaseAmount), 15000);
    assert.equal(Number((await row('2026-02'))!.cumPurchaseAmount), 35000);
    assert.equal(Number((await row('2026-03'))!.cumPurchaseAmount), 50000);
    // 当月实际采购额 = a − c − d（无资金费用/逾期 → 等于本月结算额）
    assert.equal(Number((await row('2026-02'))!.monthActualPurchase), 20000);
    // 本年结算额 = 同合同同自然年各月合计
    assert.equal(Number((await row('2025-12'))!.yearSettleAmount), 5000);
    assert.equal(Number((await row('2026-01'))!.yearSettleAmount), 45000, '2026 年 1+2+3 月 = 45000');
    assert.equal(Number((await row('2026-03'))!.yearSettleAmount), 45000);
  });

  it('⑳ 截止当月开累采购额 = Σ当月实际采购额 b（a−c−d），非 Σ本月结算额 a', async () => {
    const project = await makeProject(ctx.prisma, 'LINK-18');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    const mk = (amount: number, y: number, m: number) =>
      settle.create(
        { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount, settleDate: month(y, m) },
        project.id,
      );
    await mk(10000, 2026, 1);
    await mk(10000, 2026, 2);
    // 2026-01 保理贴息 c=1000；2026-02 逾期利息 d=500 → 当月实际采购额 b = a − c − d
    await ctx.prisma.factoringCost.create({ data: { contractId: contract.id, settlementMonth: '2026-01', totalCost: 1000 } });
    await ctx.prisma.overduePayable.create({ data: { contractId: contract.id, settlementMonth: '2026-02', overdueInterest: 500 } });

    await settle.refreshLedger(project.id);
    const row = (mm: string) =>
      ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: mm } });

    // 开工结算额 = Σ 本月结算额 a = 20000（不受 c/d 影响）
    assert.equal(Number((await row('2026-01'))!.startSettleAmount), 20000);
    // 当月实际采购额 b = a − c − d
    assert.equal(Number((await row('2026-01'))!.monthActualPurchase), 9000, '2026-01 b = 10000 − 1000');
    assert.equal(Number((await row('2026-02'))!.monthActualPurchase), 9500, '2026-02 b = 10000 − 500');
    // 截止当月开累采购额 = Σ b（而非 Σ a=10000/20000）
    assert.equal(Number((await row('2026-01'))!.cumPurchaseAmount), 9000);
    assert.equal(Number((await row('2026-02'))!.cumPurchaseAmount), 18500, '9000 + 9500');
  });
});
