// @domains: ai, project
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, uniq, type IntContext } from './helpers';
import { AnalyticsService } from '../src/modules/ai-insight/analytics/analytics.service';
import type { JwtUser } from '../src/common/decorators/user.decorator';

/**
 * 集成 · AI 经营数据助手 **访问矩阵**（计划 §2.6）：
 * 本人 / 同项目非本人（404）/ 超管 all=1 / 数据集权限被收回（404）/ DELETE 需要 ai:use。
 */
describe('集成 · AI 经营数据助手 访问矩阵', () => {
  let ctx: IntContext;
  let service: AnalyticsService;

  before(async () => {
    ctx = await bootIntApp();
    service = ctx.get<AnalyticsService>(AnalyticsService);
  });
  after(async () => {
    await ctx.app.close();
  });

  const ALL_VIEW = ['ai:use', 'ai:view', 'contract:view', 'settlement:view', 'payment:view', 'invoice:view', 'daily:view'];

  async function makeUser(permissions: string[], isSuperAdmin = false) {
    const user = await ctx.prisma.user.create({
      data: { username: uniq('int-ai-access'), password: 'x', realName: '访问矩阵用户', isSuperAdmin } as any,
    });
    return {
      id: user.id,
      jwt: {
        userId: user.id,
        username: user.username,
        realName: user.realName,
        isSuperAdmin,
        permissions,
      } as JwtUser,
    };
  }

  it('创建人可见、同项目非创建人 404、超管 all=1 可见、DELETE 需 ai:use', async () => {
    const project = await makeProject(ctx.prisma, 'AI-ACCESS');
    const owner = await makeUser(ALL_VIEW);
    const peer = await makeUser(ALL_VIEW);
    const admin = await makeUser([], true);
    await ctx.prisma.projectMember.create({ data: { projectId: project.id, userId: owner.id } });
    await ctx.prisma.projectMember.create({ data: { projectId: project.id, userId: peer.id } });

    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000, status: 'SIGNED' });
    await ctx.prisma.contract.update({ where: { id: contract.id }, data: { signDate: new Date() } as any });

    const report = await service.report(
      {
        scope: { mode: 'current' },
        period: { preset: 'this_year' },
        compare: 'none',
        datasets: ['contract.summary'],
        narrative: false,
      },
      project.id,
      owner.jwt,
    );
    assert.ok(report.id);

    // 本人：默认历史可见（按项目过滤，避免历史运行留下的同名记录干扰计数）
    assert.equal((await service.list(owner.jwt, { projectId: project.id })).total, 1);

    // 同项目非创建人：列表为空、详情 404（不泄露存在性）
    assert.equal((await service.list(peer.jwt, { projectId: project.id })).total, 0);
    await assert.rejects(() => service.detail(report.id!, peer.jwt), /记录不存在/);

    // 超管：默认仍只看本人；all=1 才看全部
    assert.equal((await service.list(admin.jwt, { projectId: project.id })).total, 0);
    assert.equal((await service.list(admin.jwt, { all: '1', projectId: project.id })).total, 1);

    // 数据集权限被收回 → 存档记录也读不到
    const revoked = { ...owner.jwt, permissions: ALL_VIEW.filter((p) => p !== 'contract:view') } as JwtUser;
    await assert.rejects(() => service.detail(report.id!, revoked), /记录不存在/);

    // DELETE 是写操作：缺 ai:use 一律 403
    const noUse = { ...owner.jwt, permissions: ALL_VIEW.filter((p) => p !== 'ai:use') } as JwtUser;
    await assert.rejects(async () => service.remove(report.id!, noUse), /权限/);

    // 本人有 ai:use → 可删除
    await service.remove(report.id!, owner.jwt);
    await assert.rejects(() => service.detail(report.id!, owner.jwt), /记录不存在/);
  });
});
