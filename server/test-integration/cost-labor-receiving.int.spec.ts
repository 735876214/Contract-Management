import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { LaborReceivingService } from '../src/modules/cost/labor-receiving.service';
import { MonthlyProfitLossService } from '../src/modules/cost/monthly-profit-loss.service';

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

  before(async () => {
    ctx = await bootIntApp();
    labor = ctx.get<LaborReceivingService>(LaborReceivingService);
    profit = ctx.get<MonthlyProfitLossService>(MonthlyProfitLossService);
  });
  after(async () => {
    await ctx.app.close();
  });

  const makeAuth = (projectId: string, name: string) =>
    ctx.prisma.laborAuthLedger.create({
      data: { projectId, subcontractorName: name } as any,
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

  const makeDoc = (projectId: string, laborAuthId: string, period: string) =>
    labor.createDoc({ laborAuthId, period, contractName: '集成测试劳务合同' }, projectId, { userId: 'int' });

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
      details: [{ materialName: '砂子', spec: before.spec, unitPrice: 999, returnQty: 2 }],
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
      details: [{ materialName: '碎石', spec: '', designQtyCum: 50 }],
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
});
