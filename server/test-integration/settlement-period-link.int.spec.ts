import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeSupplier, uniq, type IntContext } from './helpers';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { InvoiceService } from '../src/modules/invoice/invoice.service';
import { ReceiptOrderService } from '../src/modules/receipt-order/receipt-order.service';
import { SETTLEMENT_STATUS, INVOICE_STATUS, SITE_CONFIRM_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · **发票/收领单 ↔ 结算单关联** 与 **月度结算自动生成**（业务口径 2026-10-16）。
 *
 * 真库验的是"闸门与链路是否真的接上了"，纯函数单测证明不了：
 * ① 发票保存 → 自动挂到**同合同同结算期**的结算单；台账「本月开票额」按**关联**归集
 *    （发票的实际开票日期在别的月份、只有账期落在本期时，也必须计入）；
 * ② 人工跨期关联 → 400（台账按「合同 + 结算期」汇总，跨期会让金额落到不属于它的行上）；
 * ③ 收领单保存 → 同样自动匹配；显式传 `null` 可解绑；
 * ④ **生成本期结算**：从上一期总日报带出明细（2026-10-18 口径），按物资合同分组各生成一张
 *    草稿结算单、金额 = Σ 日报金额、收领单仅回挂关联，且**重跑幂等**（跳过已有结算单的合同）；
 *    手工日报行同样参与；`require_confirmed` 开启时未确认行不计入。
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

  /**
   * 建一条收领单 + 对应的总日报行（本文件验的是结算侧口径）。
   *
   * 业务口径 2026-10-18：结算明细从**总日报**带出，因此夹具必须同时落 `DailyReport`；
   * 直接落库（不经 ReceiptOrderService.pushToDailyReport）是为了聚焦结算侧断言。
   */
  const makeReceipt = async (projectId: string, contractId: string, orderDate: Date, qty: number, price: number) => {
    const order = await ctx.prisma.receiptOrder.create({
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
    await makeDailyRow(projectId, contractId, orderDate, qty, price, order.orderNo, order.id);
    return order;
  };

  /** 总日报行（materialBaseId 必填，结算明细按它聚合） */
  const makeDailyRow = async (
    projectId: string,
    contractId: string | null,
    entryDate: Date,
    qty: number,
    price: number,
    receiptNo?: string,
    receiptOrderId?: string,
    confirmStatusCode: string | null = SITE_CONFIRM_STATUS.CONFIRMED,
  ) => {
    const material = await ctx.prisma.materialBase.create({
      data: { name: `集成测试物资 ${uniq('MAT')}`, spec: uniq('SPEC'), unit: '吨' },
    });
    return ctx.prisma.dailyReport.create({
      data: {
        projectId,
        contractId,
        materialBaseId: material.id,
        materialName: material.name,
        spec: material.spec,
        unit: '吨',
        entryDate,
        settleQty: qty,
        priceBeforeTax: price,
        taxRate: 0,
        priceAfterTax: price,
        amountBeforeTax: qty * price,
        amountAfterTax: qty * price,
        receiptNo: receiptNo ?? null,
        receiptOrderId: receiptOrderId ?? null,
        confirmStatusCode,
      } as any,
    });
  };

  const makeInvoice = (projectId: string, contractId: string, data: any) =>
    invoices.create({ contractId, typeCode: 'VAT_SPECIAL', statusCode: INVOICE_STATUS.WAIT_VERIFY, ...data }, projectId);

  it('① 发票自动挂同期结算单，台账「本月开票额」按关联归集（账期与开票日期可不同月）', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-1');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000 });

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
    const contract = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000 });

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
    const contract = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000 });
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
    const c1 = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000, code: uniq('INT-C1').toUpperCase() });
    const c2 = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000, code: uniq('INT-C2').toUpperCase() });

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
    const contract = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000 });

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

  it('⑦ 手工录入的总日报行（无收领单）也参与结算生成', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-7');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000 });

    // 没有任何收领单，只有手工日报行
    await makeDailyRow(project.id, contract.id, day(2026, 9, 10), 2, 300);

    const preview: any = await settle.previewPreviousPeriod(project.id, '2026-10-02');
    assert.equal(preview.dailyRowCount, 1, '预览按总日报行统计');
    assert.equal(preview.pendingContracts, 1);

    const res: any = await settle.generateForPeriod(project.id, { refDate: '2026-10-02' });
    assert.equal(res.created, 1);
    assert.equal(res.receiptOrders, 0, '没有收领单也能生成');
    const s: any = await ctx.prisma.settlement.findFirst({ where: { contractId: contract.id } });
    assert.equal(Number(s.amount), 600);
    const items = await ctx.prisma.settlementItem.findMany({ where: { settlementId: s.id } });
    assert.equal(items.length, 1);
    assert.equal(Number(items[0].qty), 2);
    assert.equal(Number(items[0].totalWithTax), 600);
  });

  it('⑧ require_confirmed 开启时，未确认的总日报行不计入结算', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-8');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000 });
    await ctx.prisma.sysParam.upsert({
      where: { key: 'settlement.require_confirmed' },
      update: { value: 'true' },
      create: { key: 'settlement.require_confirmed', value: 'true' },
    });

    await makeDailyRow(project.id, contract.id, day(2026, 9, 10), 1, 100, undefined, undefined, SITE_CONFIRM_STATUS.CONFIRMED);
    await makeDailyRow(project.id, contract.id, day(2026, 9, 11), 9, 100, undefined, undefined, SITE_CONFIRM_STATUS.PENDING);

    const res: any = await settle.generateForPeriod(project.id, { refDate: '2026-10-02' });
    assert.equal(res.created, 1);
    assert.equal(res.dailyRows, 1, '未确认行不参与结算口径');
    const s: any = await ctx.prisma.settlement.findFirst({ where: { contractId: contract.id } });
    assert.equal(Number(s.amount), 100, '只算已确认的 1×100，不含未确认的 9×100');
  });
  /**
   * ⑨ 跨月账期（用户口径 2026-10-22）：月度结算起始日 ≠ 1 时，一期仍是一个月长度，
   *    只是跨两个自然月；结算单与台账行都按**后一个月**（期末所在月）归集，
   *    且「本月结算额」「结算次数」是**纯派生**列（该期结算单合计），手填一律无效。
   */
  it('⑨ 跨月账期：10/28 的结算单归到 2026-11 的台账行；本月结算额纯派生', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-9');
    await ctx.prisma.project.update({ where: { id: project.id }, data: { settlementStartDate: day(2026, 1, 26) } });
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000 });

    // 10/28 落在期 10/26-11/25 内 → 账期标签 = 期末所在月 2026-11（按自然月会错成 2026-10）
    const s: any = await settle.create(
      { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.DRAFT, amount: 1000, settleDate: day(2026, 10, 28) },
      project.id,
    );
    const row: any = await ctx.prisma.settlementLedger.findFirst({ where: { contractId: contract.id } });
    assert.ok(row, '结算单应派生出一行台账');
    assert.equal(row!.settleMonth, '2026-11', '跨月账期按后一个月（期末所在月）归集');
    assert.equal(Number(row!.monthSettleAmount), 1000, '本月结算额 = 本期结算单实际金额合计');
    assert.equal(row!.settleCount, 1, '结算次数 = 本期结算单张数');
    assert.equal(row!.settlementId, s.id, '台账行要挂上这张结算单');

    await settle.updateLedger(row!.id, { monthSettleAmount: 999, settleCount: 7, version: row!.version }, project.id);
    const after: any = await ctx.prisma.settlementLedger.findFirst({ where: { id: row!.id } });
    assert.equal(Number(after!.monthSettleAmount), 1000, '本月结算额纯派生：手填 999 被系统值覆盖');
    assert.equal(after!.settleCount, 1, '结算次数纯派生：手填 7 被系统值覆盖');
  });

  /**
   * ⑩ 唯一性口径由「自然月」改为「账期」：同一合同同一期只允许一张结算单，
   *    跨月期的两张（10/28 与 11/20 同属期 10/26-11/25）必须被拦住。
   */
  it('⑩ 同一合同同一账期只允许一张结算单（与自然月无关）', async () => {
    const project = await makeProject(ctx.prisma, 'LNK-10');
    await ctx.prisma.project.update({ where: { id: project.id }, data: { settlementStartDate: day(2026, 1, 26) } });
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { status: 'SIGNED', projectId: project.id, supplierId: supplier.id, amount: 500000 });
    const base = { contractId: contract.id, typeCode: 'PROGRESS', statusCode: SETTLEMENT_STATUS.DRAFT, amount: 100 };

    await settle.create({ ...base, settleDate: day(2026, 10, 28) }, project.id);
    // 11/20 与 10/28 同属期 10/26-11/25：两张结算单会让台账同一行的「本月结算额」重复计算
    await assert.rejects(
      () => settle.create({ ...base, settleDate: day(2026, 11, 20) }, project.id),
      (e: any) => e instanceof BadRequestException && /同一结算期只允许一张结算单/.test(e.message),
      '同一账期内再建第二张应被 400 拦住',
    );
    // 11/26 已进入下一期（11/26-12/25），可以建
    const next: any = await settle.create({ ...base, settleDate: day(2026, 11, 26) }, project.id);
    assert.ok(next?.id, '下一期应可正常新建');
  });

});
