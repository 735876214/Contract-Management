// @domains: supplier, contract
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, uniq, type IntContext } from './helpers';
import { SupplierService } from '../src/modules/supplier';

/**
 * 集成测试 · **供应商库写路径**（此前零集成覆盖，仅有纯函数层）。
 *
 * 为什么需要：供应商是**全库共享主数据**（`supplier.share.scope` 默认 GLOBAL），
 * 它的唯一性、删除保护与乐观锁一旦漏掉，影响面是「所有项目的合同、还款协议、收领单、资产台账」，
 * 而不是单个项目内的一行数据。
 *
 * 锁定四条真库契约：
 * ① `name` 全库唯一（同名 → 400，且不落库）；
 * ② 乐观锁：`update` 缺 `version` / 版本过期 → **409**（不静默覆盖别人的修改）；
 * ③ 删除保护：被合同引用时 **400**，文案点明"仅可停用"（`remove` 先过项目口径 `findOne`，
 *    再查合同/还款协议/收领单/资产台账四类引用——少查一类就是裸 P2003 → 500）；
 * ④ 停用/启用只翻 `status`，不动名称。
 */
describe('集成 · 供应商库写路径', () => {
  let ctx: IntContext;
  let svc: SupplierService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<SupplierService>(SupplierService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('① 名称全库唯一：同名第二次 400，且不留残行', async () => {
    const project = await makeProject(ctx.prisma, 'SUP-UNIQ');
    const name = uniq('集成供应商');

    const created: any = await svc.create({ name, legalPerson: '张三' }, project.id);
    // GLOBAL 共享：归属项目为空（整个系统一份主数据）
    assert.equal(created.projectId, null, 'GLOBAL 共享 → projectId 落空');
    assert.equal(created.name, name);

    const before = await ctx.prisma.supplier.count({ where: { name } });
    await assert.rejects(
      () => svc.create({ name, legalPerson: '李四' }, project.id),
      (e: any) => e instanceof BadRequestException && /已存在/.test(e.message),
      '同名供应商必须被拦（全库唯一）',
    );
    assert.equal(await ctx.prisma.supplier.count({ where: { name } }), before, '被拦的请求不得留下第二行');
  });

  it('② 乐观锁：缺 version → 409；旧版本号 → 409；改名撞名 → 400', async () => {
    const project = await makeProject(ctx.prisma, 'SUP-LOCK');
    const a: any = await svc.create({ name: uniq('供A') }, project.id);
    const b: any = await svc.create({ name: uniq('供B') }, project.id);

    await assert.rejects(
      () => svc.update(a.id, { contactName: '没有 version' }),
      (e: any) => e instanceof ConflictException,
      '省略 version 必须拒绝（否则乐观锁形同虚设）',
    );

    const first: any = await svc.update(a.id, { contactName: '第一次', version: a.version });
    assert.equal(first.contactName, '第一次');
    assert.ok(first.version > a.version, 'version 必须自增（走 versionedUpdate 才写得回去）');

    await assert.rejects(
      () => svc.update(a.id, { contactName: '拿旧版本再改', version: a.version }),
      (e: any) => e instanceof ConflictException,
      '旧版本号必须被拒',
    );

    await assert.rejects(
      () => svc.update(a.id, { name: b.name, version: first.version }),
      (e: any) => e instanceof BadRequestException && /已存在/.test(e.message),
      '改名撞上已存在的名称也要 400',
    );
  });

  it('③ 被合同引用时不可删除（文案点明仅可停用）', async () => {
    const project = await makeProject(ctx.prisma, 'SUP-REF');
    const s: any = await svc.create({ name: uniq('被引用供应商') }, project.id);
    await makeContract(ctx.prisma, { projectId: project.id, supplierId: s.id, amount: 1000 });

    await assert.rejects(
      () => svc.remove(s.id),
      (e: any) => e instanceof BadRequestException && /不可删除/.test(e.message),
      '被合同引用的供应商必须拦住（否则裸 P2003 → 500）',
    );
    assert.equal(await ctx.prisma.supplier.count({ where: { id: s.id } }), 1, '行必须还在');
  });

  it('④ 未被引用可删除；停用/启用只翻 status', async () => {
    const project = await makeProject(ctx.prisma, 'SUP-DEL');
    const s: any = await svc.create({ name: uniq('可删除供应商') }, project.id);
    assert.equal(s.status, 1);

    const off = await svc.toggle(s.id);
    assert.equal(off.status, 0, '启用 → 停用');
    const on = await svc.toggle(s.id);
    assert.equal(on.status, 1, '停用 → 启用');
    assert.equal(on.name, s.name, '停用/启用不得改名');

    await svc.remove(s.id);
    assert.equal(await ctx.prisma.supplier.count({ where: { id: s.id } }), 0);
  });
});
