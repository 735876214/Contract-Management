import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeSupplier, uniq, type IntContext } from './helpers';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { InvoiceService } from '../src/modules/invoice/invoice.service';
import { ReceiptOrderService } from '../src/modules/receipt-order/receipt-order.service';
import { SETTLEMENT_STATUS, INVOICE_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · **发票/收领单 ↔ 结算单关联** 与 **月度结算自动生成**（业务口径 2026-10-16）。
 *
 * 真库验的是"闸门与链路是否真的接上了"，纯函数单测证明不了：
 * ① 发票保存 → 自动挂到**同合同同结算期**的结算单；台账「本月开票额」按**关联**归集
 *    （发票的实际开票日期在别的月份、只有账期落在本期时，也必须计入）；
 * ② 人工跨期关联 → 400（台账按「合同 + 结算期」汇总，跨期会让金额落到不属于它的行上）；
 * ③ 收领单保存 → 同样自动匹配；显式传 `null` 可解绑；
 * ④ **生成本期结算**：抓上一期未挂结算单的收领单，按物资合同分组各生成一张草稿结算单、
 *    金额 = Σ(实收数量 × 含税单价)、收领单回挂，且**重跑幂等**（跳过已有结算单的合同）；
 * ⑤ 项目的「月度结算起始日期」不是 1 日时，期跨自然月（起始日 26 → 期 9/26–10/25），
 *    9/28 的收领单仍与期末 10/25 的结算单**同期**、可关联（用自然月判会把它们判成不同月而拒绝）。
 */
describe('集成 · 发票/收领单 ↔ 结算单关联 + 月度结算生成', () => {
  let ctx: IntContext;
  let settle: SettlementService;
  let invoices: InvoiceService;
  let receipts: ReceiptOrderService;

  /** 某月（默认 15 日，落在自然月期内） */
  const day = (y: number, m: number, d = 15) => new Date(y, m - 1, d);
  /**
   * 日期 → `YYYY-MM-DD`（本地口径）。
   * ⚠️ 不能对 `Date` 直接 `String(d).slice(0,10)`：那是 `Sat Sep 26 2026 …`。
   * 接口返回的期边界（`preview.startDate` 等）**已经是 `YYYY-MM-DD` 字符串**，直接比即可
   * —— 服务端刻意不返回 `Date`，否则 CST 容器下序列化成 ISO 会**差一天**（见 `formatDay` 的说明）。
   */
  const ymd = (v: any) => {
    const d = new Date(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  before(async () => {
    ctx = await bootIntApp();
    settle = ctx.get<SettlementService>(SettlementService);
    invoices = ctx.get<InvoiceService>(InvoiceService);
    receipts = ctx.get<ReceiptOrderService>(ReceiptOrderService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 建一条收领单（直接落库：本文件验的是结算侧口径，收领单自身的校验另有覆盖） */
  const makeReceipt = (projectId: string, contractId: string, orderDate: Date, qty: number, price: number) =>
    ctx.prisma.receiptOrder.create({
      data: {
        projectId,
        orderNo: uniq('INT-SO').toUpperCase(),
        materialContractId: contractId,
        orderDate,
        status: 'SAVED',
        details: { create: [{ materialName: '集成测试物资', unit: '吨', receivedQty: qty, priceWithTax: price }] },
      } as any,
      include: { details: true },
    });

  const makeInvoice = (projectId: string, contractId: string, data: any) =>
    invoices.create({ contractId, typeCode: 'VAT_SPECIAL', statusCode: INVOICE_STATUS.WAIT_VERIFY, ...data }, projectId);

  it('① 发票自动挂同期结算单，台账「本月开票额」按关联归集（账期与开票日期可不同月）', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-1');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 500000 });

    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 10000, settleDate: day(2026, 9) },
      project.id,
    );

    // 账期写 2026-09、开票日期却在 8 月：归属看**账期**，故必须挂到 9 月这张结算单上
    const inv = await makeInvoice(project.id, contract.id, {
      settlePeriod: '2026-09',
      invoiceDate: day(2026, 8, 20),
      amountWithTax: 8800,
      invoiceNo: uniq('INV').toUpperCase(),
    });
    const linked = await ctx.prisma.invoice.findUnique({ where: { id: (inv as any).id } });
    assert.equal(linked!.settlementId, s.id, '发票应自动挂到同合同同期的结算单上');

    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-09' } });
    assert.equal(Number(row!.monthInvoiceAmount), 8800, '台账「本月开票额」应按关联归集，而不是按开票日的自然月');

    // 改账期到 10 月：该发票不再属于 9 月这张结算单 → 关联被解除（台账随之减）
    await invoices.update((inv as any).id, { settlePeriod: '2026-10', version: 0 });
    const after: any = await ctx.prisma.invoice.findUnique({ where: { id: (inv as any).id } });
    assert.equal(after.settlementId, null, '账期改到别的期后应解绑');
    const row2 = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id, settleMonth: '2026-09' } });
    assert.equal(Number(row2!.monthInvoiceAmount), 0, '解绑后该行的开票额应归零');
  });

  it('② 人工把发票挂到**别的结算期**的结算单上 → 400', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-2');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 500000 });

    const sep: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 1000, settleDate: day(2026, 9) },
      project.id,
    );
    const oct: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 1000, settleDate: day(2026, 10) },
      project.id,
    );

    await assert.rejects(
      () =>
        makeInvoice(project.id, contract.id, {
          settlePeriod: '2026-09',
          settlementId: oct.id, // 故意跨期
          amountWithTax: 100,
          invoiceNo: uniq('INV').toUpperCase(),
        }),
      (e: any) => e instanceof BadRequestException && /结算期/.test(e.message),
      '跨期关联必须被拦住并说明原因（静默接受会让金额落到不属于它的台账行上）',
    );

    // 同期则允许（并且是人工指定的那张）
    const ok: any = await makeInvoice(project.id, contract.id, {
      settlePeriod: '2026-09',
      settlementId: sep.id,
      amountWithTax: 100,
      invoiceNo: uniq('INV').toUpperCase(),
    });
    assert.equal(ok.settlementId, sep.id);
  });

  it('③ 收领单保存时自动匹配同期结算单；显式传 null 可解绑', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-3');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 500000 });
    await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.CONFIRMED, amount: 1000, settleDate: day(2026, 9) },
      project.id,
    );

    const created: any = await receipts.create(
      {
        supplierId: supplier.id,
        supplierName: '集成测试供应商',
        supplierType: 'SUPPLIER',
        receivingUnitId: supplier.id,
        receivingUnitName: '本项目',
        receivingUnitType: 'SELF_PROJECT',
        materialContractId: contract.id,
        orderDate: day(2026, 9, 10),
      },
      project.id,
    );
    assert.ok(created?.settlementId, '收领单保存后应自动挂上同期结算单');

    const unlinked: any = await receipts.update(created.id, { settlementId: null, version: created.version });
    assert.equal(unlinked.settlementId, null, '显式传 null 表示人工解绑，服务端不应再自动匹配回去');
  });

  it('④ 生成本期结算：按合同分组、金额=Σ(实收×含税单价)、收领单回挂、重跑幂等', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-4');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const c1 = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 500000, code: uniq('INT-C1').toUpperCase() });
    const c2 = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 500000, code: uniq('INT-C2').toUpperCase() });

    const r1 = await makeReceipt(project.id, c1.id, day(2026, 9, 5), 10, 100); // 1000
    const r2 = await makeReceipt(project.id, c1.id, day(2026, 9, 28), 5, 200); // 1000
    const r3 = await makeReceipt(project.id, c2.id, day(2026, 9, 12), 3, 300); // 900
    // 期外的收领单（10 月）不应被抓走
    await makeReceipt(project.id, c1.id, day(2026, 10, 3), 1, 1);

    // 业务原例：起始日 = 每月 1 日，10/2 运行 → 抓 9/1–9/30
    const res: any = await settle.generateForPeriod(project.id, { refDate: '2026-10-02' });
    assert.equal(res.month, '2026-09');
    assert.equal(res.created, 2, '两个合同各生成一张');
    assert.equal(res.receiptOrders, 3, '只抓期内的 3 张收领单');

    const s1 = await ctx.prisma.settlement.findFirst({ where: { contractId: c1.id, settleDate: day(2026, 9, 30) } });
    assert.ok(s1, '结算单应落在期末（settleDate = 期末，台账月份由它派生）');
    assert.equal(Number(s1!.amount), 2000, '金额 = Σ(实收数量 × 含税单价)');
    assert.equal(s1!.statusCode, SETTLEMENT_STATUS.DRAFT, '自动生成的是草稿，由人复核后再提交');

    // 收领单回挂到各自的结算单
    const back1 = await ctx.prisma.receiptOrder.findMany({ where: { id: { in: [r1.id, r2.id] } } });
    assert.ok(back1.every((o: any) => o.settlementId === s1!.id), '期内收领单必须回挂到这张结算单');
    const back3: any = await ctx.prisma.receiptOrder.findUnique({ where: { id: r3.id } });
    assert.ok(back3.settlementId && back3.settlementId !== s1!.id, '另一个合同的收领单要挂到它自己那张上');

    // 台账同步：结算额/结算张数落进 2026-09 行
    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: c1.id, settleMonth: '2026-09' } });
    assert.equal(Number(row!.monthSettleAmount), 2000);
    assert.equal(row!.settlementId, s1!.id);

    // **幂等**：同一期重跑 → 没有待抓取的收领单，不新增、也不报错
    const again: any = await settle.generateForPeriod(project.id, { refDate: '2026-10-02' });
    assert.equal(again.created, 0);
    assert.equal(again.receiptOrders, 0, '收领单已回挂 → 不再被重复抓取');
    assert.equal(await ctx.prisma.settlement.count({ where: { contractId: { in: [c1.id, c2.id] }, settleDate: day(2026, 9, 30) } }), 2);

    // 期内又来了新的收领单（尚未挂单）而该合同本期**已有**结算单 → 跳过生成、只补挂关联
    const late = await makeReceipt(project.id, c1.id, day(2026, 9, 20), 4, 50);
    const third: any = await settle.generateForPeriod(project.id, { refDate: '2026-10-02' });
    assert.equal(third.created, 0, '同期已有结算单 → 不重复生成');
    assert.equal(third.skipped, 1);
    const lateRow: any = await ctx.prisma.receiptOrder.findUnique({ where: { id: late.id } });
    assert.equal(lateRow.settlementId, s1!.id, '迟到的收领单应补挂到本期已有的结算单上，避免一直悬空');
    assert.equal(
      await ctx.prisma.settlement.count({ where: { contractId: c1.id, settleDate: day(2026, 9, 30) } }),
      1,
      '补挂不得再造一张结算单',
    );
    assert.equal(Number((await ctx.prisma.settlement.findUnique({ where: { id: s1!.id } }))!.amount), 2000, '补挂不改结算单金额');
  });

  it('⑤ 起始日 26 日：期跨自然月，9/28 的收领单仍与期末 10/25 的结算单同期', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-5');
    await ctx.prisma.project.update({ where: { id: project.id }, data: { settlementStartDate: day(2026, 1, 26) } });
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 500000 });

    // 10/26 运行 → 上一期 = 9/26–10/25，期末 10/25
    const preview: any = await settle.previewPreviousPeriod(project.id, '2026-10-26');
    assert.equal(preview.startDate, '2026-09-26');
    assert.equal(preview.endDate, '2026-10-25');

    await makeReceipt(project.id, contract.id, day(2026, 9, 28), 2, 500); // 9/28 落在期内（自然月算 9 月）
    const res: any = await settle.generateForPeriod(project.id, { refDate: '2026-10-26' });
    assert.equal(res.created, 1);
    const s: any = await ctx.prisma.settlement.findFirst({ where: { contractId: contract.id } });
    assert.equal(ymd(s.settleDate), '2026-10-25');

    const ro: any = await ctx.prisma.receiptOrder.findFirst({ where: { materialContractId: contract.id } });
    assert.equal(ro.settlementId, s.id, '9/28 的收领单必须与期末 10/25 的结算单同期（用自然月判会漏）');
    // 该行的台账月份按期末派生 → 2026-10
    const row = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id } });
    assert.equal(row!.settleMonth, '2026-10');
    assert.equal(row!.settlementId, s.id);
  });

  it('⑥ 期间内没有收领单 → 不生成任何结算单，且预览标记 empty', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-6');
    const preview: any = await settle.previewPreviousPeriod(project.id, '2026-10-02');
    assert.equal(preview.empty, true);
    assert.equal(preview.pendingContracts, 0);
    const res: any = await settle.generateForPeriod(project.id, { refDate: '2026-10-02' });
    assert.equal(res.created, 0);
    assert.equal(res.receiptOrders, 0);
  });
});
