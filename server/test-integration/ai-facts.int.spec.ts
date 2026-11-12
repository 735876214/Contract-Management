import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, type IntContext } from './helpers';
import { FieldResolverService } from '../src/modules/ai/field-resolver.service';

/**
 * 集成测试 · AI 事实层的金额口径（2026-11-12 续审 R21）。
 *
 * 回归背景：`projectStats()` 曾对**每一行合同**（含每份补充协议）都算一次整链金额再累加，
 * 主合同 + N 份补充协议被重复计入 N+1 次 —— AI 汇报材料里的「累计合同金额」成倍虚高。
 * 契约：按**链根**只算一次；补充协议只贡献带符号的 `changeAmount`，其手填 `amount` 不参与。
 */
describe('集成 · AI 事实层金额口径', () => {
  let ctx: IntContext;
  let resolver: FieldResolverService;

  before(async () => {
    ctx = await bootIntApp();
    resolver = ctx.get<FieldResolverService>(FieldResolverService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('累计合同金额按链根计一次：主合同 amount + Σ 补充协议 changeAmount', async () => {
    const project = await makeProject(ctx.prisma, 'AI-STATS');
    const main = await makeContract(ctx.prisma, { projectId: project.id, amount: 100000 });
    await makeContract(ctx.prisma, {
      projectId: project.id,
      isSupplement: 'Y',
      parentContractId: main.id,
      // 自由填写值：按业务口径**不得**参与链求和（常是"剩余数量全价"）
      amount: 999999,
      changeAmount: 5000,
    });
    await makeContract(ctx.prisma, {
      projectId: project.id,
      isSupplement: 'Y',
      parentContractId: main.id,
      amount: 888888,
      changeAmount: -2000,
    });

    const stats = await resolver.projectStats(project.id);
    assert.equal(stats.contractAmountTotal, 103000, '链金额 = 100000 + 5000 − 2000，且只算一次');
    assert.equal(stats.contractCount, 3, '合同数仍按行统计（与工作台/台账口径一致）');
  });

  it('主合同金额未填 → 该链不计入（未知不兜 0）', async () => {
    const project = await makeProject(ctx.prisma, 'AI-STATS2');
    const main = await makeContract(ctx.prisma, { projectId: project.id, amount: null });
    await makeContract(ctx.prisma, {
      projectId: project.id,
      isSupplement: 'Y',
      parentContractId: main.id,
      amount: 50000,
      changeAmount: 50000,
    });

    const stats = await resolver.projectStats(project.id);
    assert.equal(stats.contractAmountTotal, 0, '主合同金额未知时不能把补充协议增量当成整条链金额');
  });
});
