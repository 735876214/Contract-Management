// @domains: cost, labor, receipt-order
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { LaborReceivingService } from '../src/modules/cost/labor-receiving.service';
import { MonthlyProfitLossService } from '../src/modules/cost/monthly-profit-loss.service';
import { ReceiptOrderService } from '../src/modules/receipt-order/receipt-order.service';

/**
 * 集成测试 · 成本管理「分包单位领用」的**数据准确性**（真库、真 service）。
 *
 * 纯函数单测只证明派生算式（`laborReceiving.spec.mts`），证明不了聚合查询是否接对：
 * ① **串户**：收领单 `subcontractorId` 在供应侧/领用侧都会写，按它聚合会把一张单
 *    同时算进供货分包商与领用分包商；② **均价期间**：全期间均价会让后期补录追溯改写历史期；
 * ③ **单价只读**：客户端回传 unitPrice 不应改变自动聚合值；④ **未填实收 ≠ 0**；
 * ⑤ 月度盈亏「新增」的期间入口（`options().periods`）与重新抓取的盈亏金额重算。
 */
describe('集成 · 分包领用聚合与盈亏快照', () => {
  let ctx: IntContext;
  let labor: LaborReceivingService;
  let profit: MonthlyProfitLossService;
  let receipts: ReceiptOrderService;

  before(async () => {
    ctx = await bootIntApp();
    labor = ctx.get<LaborReceivingService>(LaborReceivingService);
    profit = ctx.get<MonthlyProfitLossService>(MonthlyProfitLossService);
    receipts = ctx.get<ReceiptOrderService>(ReceiptOrderService);
  });
  after(async () => {
    await ctx.app.close();
  });

  // 2026-11-20：分包单位升格为独立主数据（Subcontractor），成本侧聚合键随之从
  // laborAuthId 改为 subcontractorId，本 spec 直接建主数据行即可。
  const makeAuth = (projectId: string, name: string) =>
    ctx.prisma.subcontractor.create({
      data: { projectId, name } as any,
    });

  /** 直接落收领单（绕过 service，聚焦成本侧聚合口径） */
  const makeReceipt = async (params: {
    projectId: string;
    orderDate: Date;
    receivingUnitId: string;
    subcontractorId?: string | null;
    materialName: string;
    specModel?: string;
    unit?: string;
    receivedQty?: number | null;
    priceBeforeTax?: number | null;
  }) => {
    return ctx.prisma.receiptOrder.create({
      data: {
        projectId: params.projectId,
        orderNo: uniq('INT-SO').toUpperCase(),
        orderDate: params.orderDate,
        receivingUnitType: 'SUBCONTRACTOR',
        receivingUnitId: params.receivingUnitId,
        receivingUnitName: '领用分包商',
        subcontractorId: params.subcontractorId ?? null,
        details: {
          create: [{
            materialName: params.materialName,
            specModel: params.specModel ?? '',
            unit: params.unit ?? '吨',
            receivedQty: params.receivedQty === undefined ? 10 : params.receivedQty,
            priceBeforeTax: params.priceBeforeTax === undefined ? 100 : params.priceBeforeTax,
          }],
        },
      } as any,
      include: { details: true },
    });
  };

  const makeDoc = (projectId: string, subcontractorId: string, period: string) =>
    labor.createDoc({ subcontractorId, period, contractName: '集成测试劳务合同' }, projectId, { userId: 'int' });

  const rowOf = (details: any[], materialName: string) =>
    details.find((d) => d.materialName === materialName);

  it('串户：只认领用单位=分包商，供应侧分包商不重复计入', async () => {
    const project = await makeProject(ctx.prisma, 'COST-SHARED');
    const supplierSub = await makeAuth(project.id, '供货分包商');
    const receiverSub = await makeAuth(project.id, '领用分包商');

    // 一张单：A 供货给 B —— subcontractorId=A（供应侧），receivingUnitId=B（领用侧）
    await makeReceipt({
      projectId: project.id,
      orderDate: new Date(2026, 9, 15),
      receivingUnitId: receiverSub.id,
      subcontractorId: supplierSub.id,
      materialName: '钢筋',
      specModel: 'HRB400',
      receivedQty: 10,
      priceBeforeTax: 100,
    });

    const docA = await makeDoc(project.id, supplierSub.id, '2026-10');
    const rowsA = (await labor.docDetail(docA.id, project.id)).details;
    assert.equal(rowOf(rowsA, '钢筋'), undefined, '供货分包商不应把该单算进自己的领用（串户虚增）');

    const docB = await makeDoc(project.id, receiverSub.id, '2026-10');
    const rowB = rowOf((await labor.docDetail(docB.id, project.id)).details, '钢筋');
    assert.ok(rowB, '领用分包商应看到该单');
    assert.equal(rowB.receivedQty, 10);
    assert.equal(rowB.unitPrice, 100);
  });

  it('平均单价取截至本期末的加权均价：后期收领单不追溯改写历史期', async () => {
    const project = await makeProject(ctx.prisma, 'COST-PERIOD');
    const auth = await makeAuth(project.id, '期间分包商');
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 10), receivingUnitId: auth.id, materialName: '水泥', receivedQty: 10, priceBeforeTax: 100 });
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 10, 10), receivingUnitId: auth.id, materialName: '水泥', receivedQty: 10, priceBeforeTax: 200 });
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 11, 10), receivingUnitId: auth.id, materialName: '水泥', receivedQty: 10, priceBeforeTax: 300 });

    const oct = rowOf((await labor.docDetail((await makeDoc(project.id, auth.id, '2026-10')).id, project.id)).details, '水泥');
    const nov = rowOf((await labor.docDetail((await makeDoc(project.id, auth.id, '2026-11')).id, project.id)).details, '水泥');
    const dec = rowOf((await labor.docDetail((await makeDoc(project.id, auth.id, '2026-12')).id, project.id)).details, '水泥');
    assert.equal(oct.unitPrice, 100, '10 月只应看到 10 月的均价');
    assert.equal(nov.unitPrice, 150, '11 月 = (10×100 + 10×200) ÷ 20');
    assert.equal(dec.unitPrice, 200, '12 月 = 三期累计均价');
  });

  it('平均单价只读：客户端回传 unitPrice 不生效', async () => {
    const project = await makeProject(ctx.prisma, 'COST-READONLY');
    const auth = await makeAuth(project.id, '只读分包商');
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 10), receivingUnitId: auth.id, materialName: '砂子', receivedQty: 10, priceBeforeTax: 100 });
    const doc = await makeDoc(project.id, auth.id, '2026-10');
    const before = rowOf((await labor.docDetail(doc.id, project.id)).details, '砂子');

    await labor.updateDoc(doc.id, {
      version: doc.version,
      details: [{ materialName: '砂子', spec: before.spec, unit: before.unit, unitPrice: 999, returnQty: 2 }],
    }, project.id);

    const afterRow = rowOf((await labor.docDetail(doc.id, project.id)).details, '砂子');
    assert.equal(afterRow.unitPrice, 100, '单价必须仍来自收领单聚合，不能被客户端覆盖');
    assert.equal(afterRow.returnQty, 2, '手填字段应正常保存');
  });

  it('未填实收 ≠ 0：不建数量桶、不参与加权平均', async () => {
    const project = await makeProject(ctx.prisma, 'COST-NULL');
    const auth = await makeAuth(project.id, '空数量分包商');
    const doc = await makeDoc(project.id, auth.id, '2026-10');
    // 先落一行手填骨架（设计量），再放一张实收为空的收领单
    await labor.updateDoc(doc.id, {
      version: doc.version,
      details: [{ materialName: '碎石', spec: '', unit: '吨', designQtyCum: 50 }],
    }, project.id);
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 12), receivingUnitId: auth.id, materialName: '碎石', receivedQty: null, priceBeforeTax: 100 });

    const row = rowOf((await labor.docDetail(doc.id, project.id)).details, '碎石');
    assert.ok(row, '手填行应保留');
    assert.equal(row.receivedQty, null, '未填实收必须保持 null，不能兜成 0');
    assert.equal(row.unitPrice, null, '没有有效数量的单不参与加权平均');
  });

  it('期间入口与盈亏快照：options().periods 可用，重新抓取按新价重算盈亏金额', async () => {
    const project = await makeProject(ctx.prisma, 'COST-PROFIT');
    const auth = await makeAuth(project.id, '盈亏分包商');
    const receipt = await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 10), receivingUnitId: auth.id, materialName: '混凝土', receivedQty: 10, priceBeforeTax: 100 });
    await makeDoc(project.id, auth.id, '2026-10');

    const opts = await labor.options(project.id);
    assert.ok(opts.periods.includes('2026-10'), '月度盈亏「新增」的期间下拉必须有数据来源');

    const created: any = await profit.create({ period: '2026-10' }, project.id, { userId: 'int' });
    const detail = created.details.find((d: any) => d.materialName === '混凝土');
    assert.ok(detail, '应生成当期节超快照');
    const oldAmount = detail.saveOverAmount;
    assert.equal(detail.unitPrice, 100);

    // 同期补录/改价后重新抓取：单价与盈亏金额都必须按新值重算，不能沿用旧金额
    await ctx.prisma.receiptOrderDetail.updateMany({
      where: { orderId: receipt.id },
      data: { priceBeforeTax: 200 },
    });
    const refreshed: any = await profit.reSnapshot(created.id, project.id);
    const next = refreshed.details.find((d: any) => d.materialName === '混凝土');
    assert.equal(next.unitPrice, 200);
    assert.notEqual(next.saveOverAmount, oldAmount);
    assert.equal(next.saveOverAmount, Number((Number(next.saveOverQty) * 200).toFixed(2)));
  });

  it('盈亏快照冻结：改单价/数量一律 400，只有责任人/劳务计价已扣/备注生效', async () => {
    const project = await makeProject(ctx.prisma, 'COST-FROZEN');
    const auth = await makeAuth(project.id, '冻结分包商');
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 10), receivingUnitId: auth.id, materialName: '砂浆', receivedQty: 10, priceBeforeTax: 50 });
    const doc = await makeDoc(project.id, auth.id, '2026-10');
    await labor.updateDoc(doc.id, {
      version: doc.version,
      details: [{ materialName: '砂浆', spec: '', unit: '吨', designQtyCum: 8 }],
    }, project.id);

    const created: any = await profit.create({ period: '2026-10' }, project.id, { userId: 'int' });
    const snapshot = created.details.find((d: any) => d.materialName === '砂浆');
    assert.ok(snapshot, '应生成砂浆快照');

    // 快照列被显式改值 → 400（与台账“只读派生列不静默忽略”同一口径）
    await assert.rejects(
      () => profit.update(created.id, {
        version: created.version,
        details: [{ id: snapshot.id, unitPrice: 999, entryQty: 999 }],
      }, project.id),
      (e: any) => e instanceof BadRequestException && /快照派生物/.test(e.message),
      '改快照单价/数量必须 400，不能静默忽略',
    );

    // 只改手填字段 → 正常保存；快照列原值不变
    const updated: any = await profit.update(created.id, {
      version: created.version,
      details: [{ id: snapshot.id, owner: '张三', deductAmount: 12.5, remark: '已核' }],
    }, project.id);
    const row = updated.details.find((d: any) => d.id === snapshot.id);
    assert.equal(row.unitPrice, 50);
    assert.equal(row.entryQty, snapshot.entryQty);
    assert.equal(row.owner, '张三');
    assert.equal(row.deductAmount, 12.5);
    assert.equal(row.remark, '已核');
  });

  it('单据状态只接受 DRAFT/COMPLETED；材料名保存时 trim', async () => {
    const project = await makeProject(ctx.prisma, 'COST-STATUS');
    const auth = await makeAuth(project.id, '状态分包商');
    const doc = await makeDoc(project.id, auth.id, '2026-10');

    await assert.rejects(
      () => labor.updateDoc(doc.id, { version: doc.version, status: 'BOGUS' }, project.id),
      (e: any) => e instanceof BadRequestException,
      '非法状态必须 400，不能靠 pickFields 静默落库',
    );

    const saved = await labor.updateDoc(doc.id, {
      version: doc.version,
      status: 'COMPLETED',
      details: [{ materialName: '  砂浆  ', spec: 'M5', returnQty: 1 }],
    }, project.id);
    assert.equal(saved.status, 'COMPLETED');
    assert.ok(rowOf(saved.details, '砂浆'), '材料名应 trim 后落库，并按 trim 后的键取到');
  });

  it('行键含计量单位：同材料+规格、不同单位分成两行，不合并数量/均价', async () => {
    const project = await makeProject(ctx.prisma, 'COST-UNIT');
    const auth = await makeAuth(project.id, '单位分包商');
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 10), receivingUnitId: auth.id, materialName: '钢管', specModel: 'DN50', unit: '米', receivedQty: 10, priceBeforeTax: 20 });
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 11), receivingUnitId: auth.id, materialName: '钢管', specModel: 'DN50', unit: '根', receivedQty: 5, priceBeforeTax: 30 });

    const doc = await makeDoc(project.id, auth.id, '2026-10');
    const rows = (await labor.docDetail(doc.id, project.id)).details.filter((d) => d.materialName === '钢管');
    assert.equal(rows.length, 2, '同材料同规格但单位不同必须是两行');
    const byUnit = new Map(rows.map((d) => [d.unit, d]));
    assert.equal(byUnit.get('米').receivedQty, 10);
    assert.equal(byUnit.get('米').unitPrice, 20);
    assert.equal(byUnit.get('根').receivedQty, 5);
    assert.equal(byUnit.get('根').unitPrice, 30);

    // 两行手填值分别落库：唯一键与 upsert 定位都含单位，不会互相覆盖
    const saved = await labor.updateDoc(doc.id, {
      version: doc.version,
      details: [
        { materialName: '钢管', spec: 'DN50', unit: '米', returnQty: 1 },
        { materialName: '钢管', spec: 'DN50', unit: '根', returnQty: 2 },
      ],
    }, project.id);
    const savedRows = saved.details.filter((d) => d.materialName === '钢管');
    assert.equal(savedRows.length, 2);
    const savedByUnit = new Map(savedRows.map((d) => [d.unit, d]));
    assert.equal(savedByUnit.get('米').returnQty, 1);
    assert.equal(savedByUnit.get('根').returnQty, 2);
  });

  it('历史空单位行回落到唯一聚合单位，不产生幽灵行', async () => {
    const project = await makeProject(ctx.prisma, 'COST-LEGACY-UNIT');
    const auth = await makeAuth(project.id, '历史单位分包商');
    const doc = await makeDoc(project.id, auth.id, '2026-10');
    // 模拟迁移未覆盖到的历史行：unit = ''，带手填退库
    await ctx.prisma.laborReceivingSummary.create({
      data: {
        projectId: project.id,
        docId: doc.id,
        subcontractorId: auth.id,
        subcontractorName: auth.name,
        period: '2026-10',
        materialName: '钢板',
        spec: 'Q235',
        unit: '',
        returnQty: 3,
      } as any,
    });
    await makeReceipt({
      projectId: project.id,
      orderDate: new Date(2026, 9, 12),
      receivingUnitId: auth.id,
      materialName: '钢板',
      specModel: 'Q235',
      unit: '吨',
      receivedQty: 10,
      priceBeforeTax: 100,
    });

    const rows = (await labor.docDetail(doc.id, project.id)).details.filter((d) => d.materialName === '钢板');
    assert.equal(rows.length, 1, '空单位历史行应回落到唯一聚合单位，不能出现两行');
    assert.equal(rows[0].unit, '吨');
    assert.equal(rows[0].returnQty, 3, '手填退库应挂到聚合行上');
    assert.equal(rows[0].receivedQty, 10);
  });

  it('已存行改计量单位 → 400，不新建孤儿行', async () => {
    const project = await makeProject(ctx.prisma, 'COST-UNIT-LOCK');
    const auth = await makeAuth(project.id, '单位锁定分包商');
    await makeReceipt({
      projectId: project.id,
      orderDate: new Date(2026, 9, 12),
      receivingUnitId: auth.id,
      materialName: '型钢',
      specModel: 'I20',
      unit: '吨',
      receivedQty: 10,
      priceBeforeTax: 100,
    });
    const doc = await makeDoc(project.id, auth.id, '2026-10');
    const afterSave: any = await labor.updateDoc(doc.id, {
      version: doc.version,
      details: [{ materialName: '型钢', spec: 'I20', unit: '吨', returnQty: 1 }],
    }, project.id);
    const savedRow = afterSave.details.find((d: any) => d.materialName === '型钢');
    assert.ok(savedRow?.id, '第一次保存应落一行');

    await assert.rejects(
      () => labor.updateDoc(doc.id, {
        version: afterSave.version,
        details: [{ id: savedRow.id, materialName: '型钢', spec: 'I20', unit: '米', returnQty: 2 }],
      }, project.id),
      (e: any) => e instanceof BadRequestException && /计量单位不可修改/.test(e.message),
      '改单位必须 400，不能静默新建一行让旧行手填值孤立',
    );
  });

  it('聚合侧规格 trim：收领单规格带空格仍与保存行合并', async () => {
    const project = await makeProject(ctx.prisma, 'COST-SPEC-TRIM');
    const auth = await makeAuth(project.id, '规格分包商');
    await makeReceipt({
      projectId: project.id,
      orderDate: new Date(2026, 9, 12),
      receivingUnitId: auth.id,
      materialName: '钢管',
      specModel: '  DN50  ',
      unit: '吨',
      receivedQty: 10,
      priceBeforeTax: 20,
    });
    const doc = await makeDoc(project.id, auth.id, '2026-10');
    await labor.updateDoc(doc.id, {
      version: doc.version,
      details: [{ materialName: '钢管', spec: 'DN50', unit: '吨', returnQty: 1 }],
    }, project.id);
    const rows = (await labor.docDetail(doc.id, project.id)).details.filter((d) => d.materialName === '钢管');
    assert.equal(rows.length, 1, '规格两侧 trim 后应合并为一行');
    assert.equal(rows[0].receivedQty, 10);
    assert.equal(rows[0].returnQty, 1);
  });

  it('收领单材料清单按单位去重，行 key 唯一', async () => {
    const project = await makeProject(ctx.prisma, 'COST-MATERIAL-KEY');
    const auth = await makeAuth(project.id, '材料清单分包商');
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 10), receivingUnitId: auth.id, materialName: '钢管', specModel: 'DN50', unit: '米', receivedQty: 1, priceBeforeTax: 10 });
    await makeReceipt({ projectId: project.id, orderDate: new Date(2026, 9, 11), receivingUnitId: auth.id, materialName: '钢管', specModel: 'DN50', unit: '根', receivedQty: 1, priceBeforeTax: 20 });

    const res: any = await receipts.subcontractorMaterials(auth.id, project.id);
    const list: any[] = res.list || res || [];
    const steel = list.filter((x) => x.materialName === '钢管');
    assert.equal(steel.length, 2, '同材料同规格不同单位应两行');
    assert.equal(new Set(steel.map((x) => x.key)).size, 2, '两行 key 必须不同（否则前端 patch/delete 会同时命两行）');
  });
});
