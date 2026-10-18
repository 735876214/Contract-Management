import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, type IntContext } from './helpers';
import { MilestoneService } from '../src/modules/contract/milestone.service';
import { ContractService } from '../src/modules/contract/contract.service';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { CONTRACT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · 合同履约节点（四域扩展按需项 2026-10-18）。
 * 真库验：CRUD 全链、跨项目 404、归档合同禁止写、逾期节点进工作台待办。
 */
describe('集成 · 合同履约节点', () => {
  let ctx: IntContext;
  let milestones: MilestoneService;
  let contracts: ContractService;
  let dashboard: DashboardService;

  before(async () => {
    ctx = await bootIntApp();
    milestones = ctx.get<MilestoneService>(MilestoneService);
    contracts = ctx.get<ContractService>(ContractService);
    dashboard = ctx.get<DashboardService>(DashboardService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('CRUD 全链：创建/列表带 overdue/更新/删除', async () => {
    const project = await makeProject(ctx.prisma, 'MS-1');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 100, status: CONTRACT_STATUS.SIGNED });

    const overdue: any = await milestones.create(
      contract.id,
      { name: '主体完工', planDate: '2026-09-01', statusCode: 'PENDING' },
      project.id,
      { userId: 'u1', username: 'tester' },
    );
    const future: any = await milestones.create(
      contract.id,
      { name: '结算完成', planDate: '2027-01-01', statusCode: 'PENDING' },
      project.id,
      { userId: 'u1', username: 'tester' },
    );

    const list: any = await milestones.list(contract.id, project.id);
    assert.equal(list.length, 2);
    assert.equal(list.find((x: any) => x.id === overdue.id).overdue, true, '计划日期已过 → 逾期');
    assert.equal(list.find((x: any) => x.id === future.id).overdue, false);

    const updated: any = await milestones.update(
      contract.id,
      overdue.id,
      { statusCode: 'DONE', actualDate: '2026-09-05', version: overdue.version },
      project.id,
    );
    assert.equal(updated.statusCode, 'DONE');
    const list2: any = await milestones.list(contract.id, project.id);
    assert.equal(list2.find((x: any) => x.id === overdue.id).overdue, false, '完成后不再逾期');

    assert.equal(await milestones.remove(contract.id, overdue.id, project.id), true);
    assert.equal((await milestones.list(contract.id, project.id)).length, 1);
    void future;
  });

  it('跨项目 404；非法状态 400', async () => {
    const p1 = await makeProject(ctx.prisma, 'MS-2A');
    const p2 = await makeProject(ctx.prisma, 'MS-2B');
    const contract = await makeContract(ctx.prisma, { projectId: p1.id, amount: 100 });
    await assert.rejects(() => milestones.list(contract.id, p2.id), /合同不存在/);
    await assert.rejects(
      () => milestones.create(contract.id, { name: 'x', statusCode: 'NOPE' }, p1.id, { username: 't' }),
      /状态取值非法/,
    );
  });

  it('归档合同禁止写履约节点；逾期节点进工作台待办', async () => {
    const project = await makeProject(ctx.prisma, 'MS-3');
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      amount: 100,
      status: CONTRACT_STATUS.SIGNED,
    });
    await ctx.prisma.contract.update({ where: { id: contract.id }, data: { execStatus: 'DONE_SETTLED' } });
    await contracts.archive(contract.id, project.id, { username: 'tester' });

    await assert.rejects(
      () => milestones.create(contract.id, { name: 'x' }, project.id, { username: 't' }),
      /合同已归档/,
    );

    // 未归档合同的逾期节点进工作台
    const open = await makeContract(ctx.prisma, { projectId: project.id, amount: 100, status: CONTRACT_STATUS.SIGNED });
    await milestones.create(
      open.id,
      { name: '主体完工', planDate: '2026-01-01', statusCode: 'PENDING' },
      project.id,
      { userId: 'u1', username: 'tester' },
    );
    const todos: any = await dashboard.todos(project.id, { permissions: ['contract:view'], isSuperAdmin: true });
    const group = todos.groups.find((g: any) => g.key === 'OVERDUE_MILESTONE');
    assert.ok(group, '工作台应包含 OVERDUE_MILESTONE 组');
    assert.equal(group.count, 1);
    assert.equal(group.items[0].target.editor, open.id);
  });
});
