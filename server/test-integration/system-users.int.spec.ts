import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, uniq, type IntContext } from './helpers';
import { SystemService } from '../src/modules/system/system.service';

/**
 * 集成测试 · **用户与角色维护**（2026-11-12 续审 R12）。
 *
 * 背景：前端用户管理页曾提交 `roles`（后端只认 `roleIds`）、角色页提交的 `permissionIds`
 * 里混入树的**模块分组 key**；后端 `createRole` 又把 `permissionIds` 直接交给 Prisma。
 * 结果是「选角色/选权限保存后不生效」甚至 500。本用例锁死三条写入契约：
 * ① 角色：新建/编辑时 permissionIds 真正落关联表，且可整体替换；
 * ② 用户：roleIds 真正落关联表，且可清空；
 * ③ 用户名缺失 → 400（不再由 Prisma 抛 500）；
 * ④ 口令强度：弱口令（长度够但纯字母 / 常见弱口令）→ 400（第 24 轮审计：原来只校验 ≥ 6）。
 */
describe('集成 · 用户与角色维护', () => {
  let ctx: IntContext;
  let system: SystemService;

  before(async () => {
    ctx = await bootIntApp();
    system = ctx.get<SystemService>(SystemService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('角色权限：新建落关联表，编辑可整体替换', async () => {
    const perms = await ctx.prisma.permission.findMany({ take: 2, orderBy: { code: 'asc' } });
    assert.equal(perms.length, 2, '权限字典至少需要两条（由启动播种创建）');
    const code = uniq('ROLE');
    const role: any = await system.createRole({
      code,
      name: '集成测试角色',
      remark: null,
      permissionIds: perms.map((p) => p.id),
    });
    assert.equal(
      await ctx.prisma.rolePermission.count({ where: { roleId: role.id } }),
      2,
      '新建角色应写入勾选的权限',
    );

    await system.updateRole(role.id, { name: '集成测试角色（改）', permissionIds: [perms[0].id] });
    const left = await ctx.prisma.rolePermission.findMany({ where: { roleId: role.id } });
    assert.deepEqual(left.map((r) => r.permissionId), [perms[0].id], '编辑应整体替换为一条权限');
  });

  it('用户角色：roleIds 落关联表，可清空；用户名缺失 400', async () => {
    const role: any = await ctx.prisma.role.create({ data: { code: uniq('R'), name: '临时角色' } });
    const username = uniq('int-user');
    const user: any = await system.createUser({
      username,
      password: 'int-test-pass1',
      realName: '集成测试用户',
      status: 1,
      roleIds: [role.id],
    });
    assert.equal(
      await ctx.prisma.userRole.count({ where: { userId: user.id } }),
      1,
      '新建用户应写入角色关联',
    );

    await system.updateUser(user.id, { realName: '集成测试用户（改）', roleIds: [] });
    assert.equal(
      await ctx.prisma.userRole.count({ where: { userId: user.id } }),
      0,
      '提交空 roleIds 应清空角色',
    );

    await assert.rejects(
      () => system.createUser({ password: 'x', realName: '无用户名' }),
      (e: any) => e instanceof BadRequestException && /用户名/.test(e.message),
      '用户名缺失应为 400',
    );

    // ④ 口令强度：下面两种都不合格，必须在写库前 400（不能"建了一半的用户"）
    for (const [pwd, why] of [
      ['abcdefgh', '纯字母'],
      ['admin123', '常见弱口令'],
      ['ab1', '长度不足'],
    ] as const) {
      await assert.rejects(
        () => system.createUser({ username: uniq('int-weak'), password: pwd, realName: '弱口令' }),
        (e: any) => e instanceof BadRequestException && /密码|弱口令/.test(e.message),
        `弱口令（${why}）应为 400`,
      );
    }
    assert.equal(
      await ctx.prisma.user.count({ where: { username: { startsWith: 'int-weak-' } } }),
      0,
      '弱口令请求不得留下任何用户行',
    );
  });
});
