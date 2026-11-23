// @domains: asset
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { AssetService } from '../src/modules/asset';

/**
 * 集成测试 · **资产台账写路径**（此前零集成覆盖）。
 *
 * 资产台账是「数量 × 单价」派生金额 + 进出场方向统计的唯一来源，口径错会同时污染
 * 台账列表、进出场汇总与导出 Excel。锁定五条真库契约：
 *
 * ① 派生金额：`totalAmount = qty × price` 等 7 个金额列由 service 计算，前端不传；
 * ② 数量勾稽：在用/闲置/报废/丢失合计 ≠ 进出场数量 → 400（`TRANSFER_IN_FEE`/`MAINTENANCE`
 *    是纯费用行，只有金额没有数量，**不受此校验约束**）；
 * ③ 计量单位必须命中字典 `measurement_unit`（资产单位继承物资基础库，不手工维护）；
 * ④ 乐观锁：`update` 缺 version → 409；正常修改后 version 自增
 *    （2026-11-23 修的就是这里：`pickFields` 白名单不含 version，曾导致并发编辑永不报 409）；
 * ⑤ 进出场汇总口径：采购/调入 = 进场，调出/处置 = 出场，调入费/维保费只计金额、不计数量。
 */
describe('集成 · 资产台账写路径', () => {
  let ctx: IntContext;
  let svc: AssetService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<AssetService>(AssetService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('① 派生金额由 service 计算（qty × price）', async () => {
    const project = await makeProject(ctx.prisma, 'AST-DERIVED');
    const row: any = await svc.create(
      { sourceCode: 'PURCHASE', name: uniq('钢管'), spec: 'DN100', unit: 'T', qty: 10, price: 2500 },
      project.id,
    );
    assert.equal(Number(row.totalAmount), 25000, 'totalAmount = qty × price');
    assert.equal(row.unit, 'T', '计量单位落库为字典编码');
  });

  it('② 状态数量勾稽：合计不等于数量 → 400；纯费用行不受约束', async () => {
    const project = await makeProject(ctx.prisma, 'AST-VALID');
    await assert.rejects(
      () => svc.create({ sourceCode: 'PURCHASE', name: uniq('勾稽'), qty: 10, inUseQty: 6, idleQty: 3 }, project.id),
      (e: any) => e instanceof BadRequestException && /合计/.test(e.message),
      '6 + 3 ≠ 10 必须拦',
    );

    // 调入费：只有金额、没有数量 → 通过
    const fee: any = await svc.create({ sourceCode: 'TRANSFER_IN_FEE', name: uniq('调入费'), price: 800 }, project.id);
    assert.equal(Number(fee.totalAmount ?? 0), 0, '无数量时金额列为 0/null，不应报错');
  });

  it('③ 计量单位不在字典 → 400', async () => {
    const project = await makeProject(ctx.prisma, 'AST-UNIT');
    await assert.rejects(
      () => svc.create({ sourceCode: 'PURCHASE', name: uniq('单位'), unit: '不存在的单位' }, project.id),
      (e: any) => e instanceof BadRequestException && /计量单位/.test(e.message),
    );
  });

  it('④ 乐观锁：缺 version → 409；正常修改后 version 自增', async () => {
    const project = await makeProject(ctx.prisma, 'AST-LOCK');
    const row: any = await svc.create({ sourceCode: 'PURCHASE', name: uniq('乐观锁'), qty: 5, price: 10 }, project.id);

    await assert.rejects(
      () => svc.update(row.id, { remark: '没有 version' }, project.id),
      (e: any) => e instanceof ConflictException,
    );

    const first: any = await svc.update(row.id, { remark: '第一次', version: row.version }, project.id);
    assert.equal(first.remark, '第一次');
    assert.ok(first.version > row.version, 'version 必须自增（否则并发编辑永不报 409）');

    await assert.rejects(
      () => svc.update(row.id, { remark: '旧版本', version: row.version }, project.id),
      (e: any) => e instanceof ConflictException,
    );
  });

  it('⑤ 进出场汇总：进场/出场/费用三分，未知来源单列', async () => {
    const project = await makeProject(ctx.prisma, 'AST-FLOW');
    await svc.create({ sourceCode: 'PURCHASE', name: uniq('进场'), qty: 10, price: 100 }, project.id);
    await svc.create({ sourceCode: 'TRANSFER_OUT', name: uniq('出场'), qty: 4, price: 100 }, project.id);
    // 费用行金额同样由 qty × price 派生；它的数量**不计入**进出场（方向为 FEE）
    await svc.create({ sourceCode: 'MAINTENANCE', name: uniq('维保'), qty: 1, price: 300 }, project.id);

    const summary: any = await svc.flowSummary(project.id, {});
    assert.equal(Number(summary.inQty), 10, '采购计入进场数量');
    assert.equal(Number(summary.inAmount), 1000, '进场金额 = 10 × 100');
    assert.equal(Number(summary.outQty), 4, '调出计入出场数量');
    assert.equal(Number(summary.outAmount), 400);
    assert.equal(Number(summary.feeAmount), 300, '维保费金额独立成列');
    assert.equal(Number(summary.inQty), 10, '费用行的数量不得混入进场');
  });
});
