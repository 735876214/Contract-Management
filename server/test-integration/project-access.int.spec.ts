import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { ProjectService } from '../src/modules/project/project.service';

/**
 * 集成测试 · **项目级访问控制**（2026-11-12 续审 R5）。
 *
 * 背景：权限码是全局 RBAC，`x-project-id` 只表达"想访问哪个项目"；
 * `GET /projects/:id` 与成员管理原先只按 id 取行，任何持 `project:view/edit`
 * 的用户换个 id 就能读别项目详情（含成员手机号/邮箱）或改删别项目。
 * 口径：**项目隔离只有成员关系一级**（product-decisions.md「不做行级数据权限」）。
 */
describe('集成 · 项目级访问控制（成员关系）', () => {
  let ctx: IntContext;
  let service: ProjectService;

  before(async () => {
    ctx = await bootIntApp();
    service = ctx.get<ProjectService>(ProjectService);
  });
  after(async () => {
    await ctx.app.close();
  });

  const makeUser = (isSuperAdmin = false) =>
    ctx.prisma.user.create({
      data: { username: uniq('int-user'), password: 'x', realName: '集成测试用户', isSuperAdmin },
    });

  it('非成员换 id 读不到别项目；成员与超管按口径放行', async () => {
    const projectA = await makeProject(ctx.prisma, 'ACC-A');
    const projectB = await makeProject(ctx.prisma, 'ACC-B');
    const user = await makeUser();
    await ctx.prisma.projectMember.create({ data: { projectId: projectA.id, userId: user.id } });
    const me = { userId: user.id, isSuperAdmin: false };

    const mine = await service.findOne(projectA.id, me);
    assert.equal(mine.id, projectA.id, '成员可读自己项目');

    const denied = (e: any) => e instanceof ForbiddenException;
    await assert.rejects(() => service.findOne(projectB.id, me), denied, '非成员读项目详情');
    await assert.rejects(() => service.members(projectB.id, me), denied, '非成员看成员名单');
    await assert.rejects(() => service.update(projectB.id, { version: 0, name: 'x' }, me), denied, '非成员改项目');
    await assert.rejects(() => service.remove(projectB.id, me), denied, '非成员删项目');
    await assert.rejects(() => service.addMember(projectB.id, user.id, 'MEMBER', me), denied, '非成员加成员');
    await assert.rejects(() => service.removeMember(projectB.id, user.id, me), denied, '非成员移成员');

    const admin = await makeUser(true);
    const asAdmin = await service.findOne(projectB.id, { userId: admin.id, isSuperAdmin: true });
    assert.equal(asAdmin.id, projectB.id, '超管按设计放行');
  });

  it('成员管理只作用于 URL 指向的项目', async () => {
    const projectA = await makeProject(ctx.prisma, 'ACC-M-A');
    const projectB = await makeProject(ctx.prisma, 'ACC-M-B');
    const actor = await makeUser();
    const target = await makeUser();
    await ctx.prisma.projectMember.create({ data: { projectId: projectA.id, userId: actor.id } });
    await ctx.prisma.projectMember.create({ data: { projectId: projectA.id, userId: target.id } });
    await ctx.prisma.projectMember.create({ data: { projectId: projectB.id, userId: target.id } });
    const me = { userId: actor.id, isSuperAdmin: false };

    await service.removeMember(projectA.id, target.id, me);
    assert.equal(
      await ctx.prisma.projectMember.count({ where: { projectId: projectA.id, userId: target.id } }),
      0,
      '本项目成员应被移除',
    );
    assert.equal(
      await ctx.prisma.projectMember.count({ where: { projectId: projectB.id, userId: target.id } }),
      1,
      '别项目的同名成员关系不受影响',
    );
  });
});
