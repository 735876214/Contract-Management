import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, uniq, type IntContext } from './helpers';
import { DatasetCollector } from '../src/modules/ai/analytics/dataset-collector.service';

/**
 * 集成 · AI 经营数据助手（Phase 5）：新增 9 个业务单据域都有真实取数。
 * 每个域造一条最小数据，断言 collector 产出的数据集行数 > 0（防止「注册表有、取数为空」）。
 */
describe('集成 · 经营数据助手 全模块数据集覆盖', () => {
  let ctx: IntContext;
  let collector: DatasetCollector;

  before(async () => {
    ctx = await bootIntApp();
    collector = ctx.get<DatasetCollector>(DatasetCollector);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('repayment / final_settlement / payment_procedure / change_log / material / labor / procurement 均有行', async () => {
    const project = await makeProject(ctx.prisma, 'ANA-COV');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 100000, status: 'SIGNED' });
    await ctx.prisma.contract.update({ where: { id: contract.id }, data: { signDate: new Date() } as any });

    await ctx.prisma.repaymentAgreement.create({
      data: {
        projectId: project.id, contractId: contract.id, code: uniq('RA'),
        signDate: new Date(), settleAmount: 80000, agreedDebtAmount: 80000, overdueUnpaid: 1000,
      } as any,
    });
    await ctx.prisma.finalSettlement.create({
      data: { projectId: project.id, contractId: contract.id, code: uniq('FS'), totalAmount: 60000, statusCode: 'SETTLED' } as any,
    });
    await ctx.prisma.paymentProcedure.create({
      data: {
        projectId: project.id, contractId: contract.id, code: uniq('PP'),
        settleCumAmount: 60000, paidCumAmount: 30000, unpaidAmount: 30000, payDate: new Date(),
      } as any,
    });
    await ctx.prisma.contractChangeLog.create({
      data: { contractId: contract.id, field: 'amount', fieldLabel: '合同金额', beforeValue: '1', afterValue: '2' } as any,
    });
    const material = await ctx.prisma.materialBase.create({
      data: { name: uniq('物资'), spec: 'S-1', unit: '个' } as any,
    });
    await ctx.prisma.contractMaterial.create({
      data: {
        contractId: contract.id, materialBaseId: material.id, unit: '个', qty: 5,
        priceBeforeTax: 10, priceWithTax: 11.3, totalWithTax: 56.5,
      } as any,
    });
    const labor = await ctx.prisma.laborAuthLedger.create({
      data: { projectId: project.id, subcontractorName: uniq('分包') } as any,
    });
    await ctx.prisma.laborReceivingDoc.create({
      data: {
        projectId: project.id, docNo: uniq('LRD'), laborAuthId: labor.id,
        subcontractorName: labor.subcontractorName, period: '2026-11',
      } as any,
    });
    const task = await ctx.prisma.procurementTask.create({
      data: { projectId: project.id, taskNo: uniq('PROC').toUpperCase(), type: 'SINGLE', content: '覆盖测试' } as any,
    });
    await ctx.prisma.procurementNotice.create({
      data: { projectId: project.id, taskId: task.id, procurementNo: uniq('PN'), procurementTime: new Date() } as any,
    });
    const bidder = await ctx.prisma.procurementBidder.create({
      data: { projectId: project.id, taskId: task.id, bidderName: uniq('投标单位') } as any,
    });
    await ctx.prisma.procurementEvaluation.create({
      data: {
        projectId: project.id, taskId: task.id, bidderId: bidder.id, evaluator: '张三',
        score: 90, rank: 1, conclusion: 'RECOMMEND', evaluatedAt: new Date(),
      } as any,
    });
    await ctx.prisma.inspectionReport.create({
      data: { projectId: project.id, unitName: uniq('考察单位'), inspectionTime: new Date() } as any,
    });

    const collected = await collector.collect(
      [{ id: project.id, code: project.code, name: project.name }],
      { from: new Date(2026, 0, 1), to: new Date(2026, 11, 31, 23, 59, 59, 999) },
      null,
    );
    const rowsOf = (key: string) => collected.datasets.find((d) => d.key === key)?.rows.length ?? 0;
    const expectations: Array<[string, number]> = [
      ['repayment.agreement', 1],
      ['final_settlement.summary', 1],
      ['payment_procedure.records', 1],
      ['contract.change_log', 1],
      ['material.contract', 1],
      ['labor.auth', 1],
      ['labor.receiving_doc', 1],
      ['procurement.documents', 3], // 公告 + 评标 + 考察
    ];
    for (const [key, min] of expectations) {
      assert.ok(rowsOf(key) >= min, `${key} 取数为空（期望 ≥${min} 行，实际 ${rowsOf(key)}）`);
    }
    assert.ok(rowsOf('material.base') >= 1, 'material.base 应包含刚建的主数据');
    assert.equal(collected.datasets.length, 27, '27 个数据集应全部产出结构（未选的由上层过滤）');
  });
});
