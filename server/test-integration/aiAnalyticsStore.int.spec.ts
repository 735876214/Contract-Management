import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, uniq, type IntContext } from './helpers';
import { AnalyticsService } from '../src/modules/ai/analytics/analytics.service';
import type { JwtUser } from '../src/common/decorators/user.decorator';

/**
 * 集成 · AI 经营数据助手（Phase 2）：确定性别报告 → 落库 → 历史。
 *
 * 覆盖：单项目报告的核心口径（合同链/结算排除草稿/付款排除失败/发票排除红黑）、
 * 成功落库、历史默认本人、非创建人 404、删除后不可再取。
 */
describe('集成 · AI 经营数据助手 报告与历史', () => {
  let ctx: IntContext;
  let service: AnalyticsService;

  before(async () => {
    ctx = await bootIntApp();
    service = ctx.get<AnalyticsService>(AnalyticsService);
  });
  after(async () => {
    await ctx.app.close();
  });

  async function makeUser(permissions: string[]) {
    const user = await ctx.prisma.user.create({
      data: { username: uniq('int-ana-rpt'), password: 'x', realName: '报告用户', isSuperAdmin: false } as any,
    });
    return {
      id: user.id,
      jwt: { userId: user.id, username: user.username, realName: user.realName, isSuperAdmin: false, permissions } as JwtUser,
    };
  }

  const ALL_VIEW = ['ai:use', 'ai:view', 'contract:view', 'settlement:view', 'payment:view', 'invoice:view', 'daily:view'];

  it('生成确定性报告并落库；历史默认本人；非创建人 404；删除后不可取', async () => {
    const project = await makeProject(ctx.prisma, 'ANA-RPT');
    const { id: userId, jwt } = await makeUser(ALL_VIEW);
    await ctx.prisma.projectMember.create({ data: { projectId: project.id, userId } });

    const main = await makeContract(ctx.prisma, { projectId: project.id, amount: 100000, status: 'SIGNED' });
    await ctx.prisma.contract.update({ where: { id: main.id }, data: { signDate: new Date() } as any });
    const extra = await makeContract(ctx.prisma, {
      projectId: project.id,
      isSupplement: 'Y',
      parentContractId: main.id,
      amount: 999999,
      changeAmount: 5000,
      status: 'SIGNED',
    });
    await ctx.prisma.contract.update({ where: { id: extra.id }, data: { signDate: new Date() } as any });

    await ctx.prisma.settlement.create({
      data: { projectId: project.id, contractId: main.id, amount: 60000, actualAmount: 60000, settleDate: new Date(), statusCode: 'CONFIRMED' } as any,
    });
    // 草稿结算不计入
    await ctx.prisma.settlement.create({
      data: { projectId: project.id, contractId: main.id, amount: 50000, actualAmount: 50000, settleDate: new Date(), statusCode: 'DRAFT' } as any,
    });
    await ctx.prisma.paymentRecord.create({
      data: { projectId: project.id, contractId: main.id, amount: 40000, payDate: new Date(), statusCode: 'PAID' } as any,
    });
    await ctx.prisma.paymentRecord.create({
      data: { projectId: project.id, contractId: main.id, amount: 7000, payDate: new Date(), statusCode: 'FAILED' } as any,
    });
    await ctx.prisma.invoice.create({
      data: {
        projectId: project.id, contractId: main.id, invoiceNo: uniq('INV'), amountWithTax: 50000,
        invoiceDate: new Date(), statusCode: 'VERIFIED',
      } as any,
    });
    // 红冲票不计入
    await ctx.prisma.invoice.create({
      data: {
        projectId: project.id, contractId: main.id, invoiceNo: uniq('INV-R'), amountWithTax: 30000,
        invoiceDate: new Date(), statusCode: 'RED',
      } as any,
    });
    await ctx.prisma.dailyReport.create({
      data: {
        projectId: project.id, contractId: main.id, entryDate: new Date(), settleQty: 12, amountAfterTax: 5000,
        confirmStatusCode: 'CONFIRMED',
      } as any,
    });

    const res = await service.report(
      {
        scope: { mode: 'current' },
        period: { preset: 'this_year' },
        compare: 'none',
        datasets: ['contract.summary', 'settlement.summary', 'payment.records', 'invoice.records', 'daily.report'],
      },
      project.id,
      jwt,
    );
    assert.ok(res.id, '成功生成应返回记录 id');
    assert.equal(res.persisted, true);
    assert.equal(res.facts.totals.signedYuan, 105000, '链口径 = 100000 + 5000，补充协议 amount 不参与');
    assert.equal(res.facts.totals.settledYuan, 60000, '草稿结算不计入');
    assert.equal(res.facts.totals.paidYuan, 40000, '失败付款不计入');
    assert.equal(res.facts.totals.invoicedYuan, 50000, '红冲发票不计入');
    assert.equal(res.facts.totals.dailyReports, 1);
    assert.ok(res.markdown.includes(project.code), '报告应包含项目编号');
    assert.equal(res.source, 'template');

    const mine = await service.list(jwt, {});
    assert.equal(mine.total, 1);
    assert.equal(mine.list[0].id, res.id);

    const other = await makeUser(ALL_VIEW);
    const otherList = await service.list(other.jwt, {});
    assert.equal(otherList.total, 0, '历史默认只返回本人的记录');
    await assert.rejects(() => service.detail(res.id!, other.jwt), /记录不存在/);

    // projectId 是可选筛选：别的项目筛不到
    const otherProject = await makeProject(ctx.prisma, 'ANA-RPT2');
    assert.equal((await service.list(jwt, { projectId: otherProject.id })).total, 0);

    await service.remove(res.id!, jwt);
    await assert.rejects(() => service.detail(res.id!, jwt), /记录不存在/);
  });
});
