// @domains: other-project
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { OtherProjectService } from '../src/modules/other-project';

/**
 * 集成测试 · **其他项目库的写路径**（纯函数层只覆盖了导入状态解析，这里补真库约束）。
 *
 * ① 名称唯一性按 **scope** 判：默认 `supplier.share.scope = GLOBAL` 时落库 `projectId = null`，
 *    于是**跨项目**同名也算重复（两个项目各建一次 → 第二次 400）；
 * ② 乐观锁：`update` 缺 `version` 或版本过期 → **409**（不静默覆盖别人的修改）；
 * ③ 删除保护：被收领单（`supplyUnitId` / `receivingUnitId`，泛型 ID 无外键）引用时 **400**，只允许停用；
 * ④ 停用/启用只翻 `status`，不动名称与编号。
 */
describe('集成 · 其他项目库写路径', () => {
  let ctx: IntContext;
  let svc: OtherProjectService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<OtherProjectService>(OtherProjectService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('① GLOBAL 共享下「同名」跨项目也算重复（落库 projectId 为空）', async () => {
    const a = await makeProject(ctx.prisma, 'OP-A');
    const b = await makeProject(ctx.prisma, 'OP-B');
    const name = uniq('其他项目');

    const created: any = await svc.create({ name, code: 'XM-1' }, a.id);
    assert.equal(created.projectId, null, 'GLOBAL 共享 → 归属项目为空');

    await assert.rejects(
      () => svc.create({ name }, b.id),
      (e: any) => e instanceof BadRequestException && /已存在/.test(e.message),
      '另一个项目建同名也必须被拦（GLOBAL 口径下是同一份主数据）',
    );
  });

  it('② 乐观锁：缺 version → 409；版本过期 → 409', async () => {
    const project = await makeProject(ctx.prisma, 'OP-LOCK');
    const row: any = await svc.create({ name: uniq('乐观锁') }, project.id);

    await assert.rejects(
      () => svc.update(row.id, { remark: '没有 version' }),
      (e: any) => e instanceof ConflictException,
      '省略 version 必须拒绝（否则乐观锁形同虚设）',
    );

    // 先被别人改一次（version 自增），再拿旧版本号提交
    await svc.update(row.id, { remark: '第一次', version: row.version });
    await assert.rejects(
      () => svc.update(row.id, { remark: '拿旧版本再改', version: row.version }),
      (e: any) => e instanceof ConflictException,
      '旧版本号必须被拒',
    );
  });

  it('③ 被收领单引用时不可删除（只可停用）', async () => {
    const project = await makeProject(ctx.prisma, 'OP-REF');
    const row: any = await svc.create({ name: uniq('被引用') }, project.id);
    await ctx.prisma.receiptOrder.create({
      data: { projectId: project.id, orderNo: uniq('SO-INT').toUpperCase(), supplyUnitId: row.id },
    });

    await assert.rejects(
      () => svc.remove(row.id),
      (e: any) => e instanceof BadRequestException && /不可删除/.test(e.message),
      '无外键的泛型引用必须显式拦截，否则会留下悬空 id',
    );
    // 仍可停用
    const off: any = await svc.toggle(row.id);
    assert.equal(off.status, 0);
  });

  it('④ 未被引用可删除；停用/启用只翻 status', async () => {
    const project = await makeProject(ctx.prisma, 'OP-DEL');
    const row: any = await svc.create({ name: uniq('可删除') }, project.id);
    const off: any = await svc.toggle(row.id);
    assert.equal(off.status, 0);
    const on: any = await svc.toggle(row.id);
    assert.equal(on.status, 1);
    assert.equal(on.name, row.name, '停用/启用不改名称');

    await svc.remove(row.id);
    assert.equal(await ctx.prisma.otherProject.count({ where: { id: row.id } }), 0);
  });
});
