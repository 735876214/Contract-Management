// @domains: ai, project
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { AnalyticsService } from '../src/modules/ai/analytics/analytics.service';
import type { JwtUser } from '../src/common/decorators/user.decorator';

/**
 * 集成 · AI 经营数据助手（Phase 1）：注册表权限过滤与规则意图的项目收口。
 *
 * 覆盖：
 * - `GET /datasets` 等价的 `listDatasets()`：无权限进 denied、未实现不暴露；
 * - `POST /plan` 等价的 `plan()`：当前项目/全部项目/多选的项目成员收口、
 *   跨项目需要 `dashboard:view`、无权数据集被剔除。
 *
 * 每个 `plan()` 都传 `{ useIntentLlm: false }`：本 spec 锁的是**规则意图**的项目收口，
 * 带上模型意图只会让结果随「网关是否配了密钥」而变（配了就 source=llm、断网又会回落 rules），
 * 断言就成了环境探针而不是回归锁。模型意图另有用例，见 aiAnalyticsStore / ai-facts。
 */
describe('集成 · AI 经营数据助手 权限与意图', () => {
  let ctx: IntContext;
  let service: AnalyticsService;

  before(async () => {
    ctx = await bootIntApp();
    service = ctx.get<AnalyticsService>(AnalyticsService);
  });
  after(async () => {
    await ctx.app.close();
  });

  async function makeUser(permissions: string[], isSuperAdmin = false) {
    const user = await ctx.prisma.user.create({
      data: {
        username: uniq('int-ana-user'),
        password: 'x',
        realName: '集成测试用户',
        isSuperAdmin,
      } as any,
    });
    return {
      jwt: { userId: user.id, username: user.username, realName: user.realName, isSuperAdmin, permissions } as JwtUser,
      id: user.id,
    };
  }

  async function join(projectId: string, userId: string) {
    await ctx.prisma.projectMember.create({ data: { projectId, userId } });
  }

  it('注册表：只返回已实现且无权限的进 denied（超管全量）', async () => {
    const { jwt } = await makeUser([], true);
    const all = await service.listDatasets(jwt);
    assert.equal(all.datasets.length, 27);
    assert.equal(all.deniedDatasets.length, 0);
    assert.equal(all.crossProjectAllowed, true);

    const limited = await makeUser(['ai:use', 'contract:view']);
    const res = await service.listDatasets(limited.jwt);
    assert.ok(res.datasets.every((d) => d.permission === 'contract:view'));
    assert.ok(res.deniedDatasets.includes('invoice.records'));
    assert.equal(res.crossProjectAllowed, false);
  });

  it('scope=current：必须是成员项目；意图回落默认数据集', async () => {
    const project = await makeProject(ctx.prisma, 'ANA-CUR');
    const { jwt } = await makeUser(['ai:use', 'contract:view', 'settlement:view', 'payment:view', 'invoice:view']);
    await join(project.id, jwt.userId);

    // 显式关掉意图 LLM：本用例断言的是**规则**路径（`.env` 里配了 AI_BASE_URL 时，
    // 有文本会自动走模型意图，source 变成 'llm'，断言就随环境漂移）
    const res = await service.plan({ text: '本月合同汇总' }, project.id, jwt, { useIntentLlm: false });
    assert.equal(res.source, 'rules');
    assert.equal(res.intent.scope.mode, 'current');
    assert.deepEqual(res.projects.map((p) => p.id), [project.id]);

    const other = await makeProject(ctx.prisma, 'ANA-OTHER');
    await assert.rejects(() => service.plan({}, other.id, jwt, { useIntentLlm: false }), /成员范围/);
  });

  it('scope=all：无 dashboard:view 被拒；有权限时返回成员项目集合', async () => {
    const p1 = await makeProject(ctx.prisma, 'ANA-ALL1');
    const p2 = await makeProject(ctx.prisma, 'ANA-ALL2');
    const { jwt } = await makeUser(['ai:use', 'contract:view']);
    await join(p1.id, jwt.userId);

    await assert.rejects(() => service.plan({ text: '全部项目合同情况' }, p1.id, jwt, { useIntentLlm: false }), /统计报表/);

    const withDash = await makeUser(['ai:use', 'contract:view', 'dashboard:view']);
    await join(p1.id, withDash.jwt.userId);
    await join(p2.id, withDash.jwt.userId);
    const res = await service.plan({ text: '全部项目合同情况' }, p1.id, withDash.jwt, { useIntentLlm: false });
    assert.equal(res.intent.scope.mode, 'all');
    const ids = res.projects.map((p) => p.id);
    assert.ok(ids.includes(p1.id));
    assert.ok(ids.includes(p2.id));
  });

  it('scope=selected：无权/未知项目被忽略并提示，mentions 回写匹配到的项目名', async () => {
    const mine = await makeProject(ctx.prisma, 'ANA-SEL');
    const notMine = await makeProject(ctx.prisma, 'ANA-SELX');
    const { jwt } = await makeUser(['ai:use', 'contract:view', 'dashboard:view']);
    await join(mine.id, jwt.userId);

    const res = await service.plan(
      { text: '合同情况', scope: { mode: 'selected', projectIds: [mine.id, notMine.id], mentions: ['不存在的项目名'] } },
      mine.id,
      jwt,
      { useIntentLlm: false },
    );
    assert.equal(res.intent.scope.mode, 'selected');
    assert.deepEqual(res.projects.map((p) => p.id), [mine.id]);
    assert.ok(res.warnings.some((w) => w.includes('忽略')));
  });

  it('无权数据集被剔除（deniedDatasets），保留有权限的', async () => {
    const project = await makeProject(ctx.prisma, 'ANA-DS');
    const { jwt } = await makeUser(['ai:use', 'contract:view']);
    await join(project.id, jwt.userId);

    const res = await service.plan(
      { datasets: ['invoice.records', 'contract.summary'], scope: { mode: 'current' } },
      project.id,
      jwt,
      { useIntentLlm: false },
    );
    assert.deepEqual(res.deniedDatasets, ['invoice.records']);
    assert.deepEqual(res.intent.datasets, ['contract.summary']);
  });

  it('显式多选超过 50 个项目 → 400（不静默截断）', async () => {
    const project = await makeProject(ctx.prisma, 'ANA-LIMIT');
    const { jwt } = await makeUser(['ai:use', 'contract:view', 'dashboard:view']);
    await join(project.id, jwt.userId);
    const ids = Array.from({ length: 51 }, (_, i) => `not-a-project-${i}`);
    await assert.rejects(
      () => service.plan({ scope: { mode: 'selected', projectIds: ids } }, project.id, jwt, { useIntentLlm: false }),
      /不能超过 50 个/,
    );
  });

  it('非法的分组维度：回落到按项目并明确提示', async () => {
    const project = await makeProject(ctx.prisma, 'ANA-GROUP');
    const { jwt } = await makeUser(['ai:use', 'contract:view']);
    await join(project.id, jwt.userId);
    const res = await service.plan({ text: '合同汇总', groupBy: 'month' }, project.id, jwt, { useIntentLlm: false });
    assert.equal(res.intent.groupBy, 'project');
    assert.ok(res.warnings.some((w) => w.includes('忽略未知的分组维度')));
  });
});