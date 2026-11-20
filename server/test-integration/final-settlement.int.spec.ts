import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeSupplier, uniq, type IntContext } from './helpers';
import { FinalSettlementService } from '../src/modules/final-settlement/final-settlement.service';
import { SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · 总结算单「生成 / 编辑明细 / 编号落库」（业务 2026-11-21 审计修复回归）。
 *
 * 纯函数证明不了闸门真的接上，这里在真库上验：
 * ① 生成抓该合同全部非草稿月度结算成明细快照，totalAmount = 明细合计，编号落库（docNumber）；
 * ② 编辑明细（月份/金额）+ 审减保存即重算合计，编号不变；
 * ③ 明细超过 36 行 → 400（模板槽位固定，防导出静默丢行）；
 * ④ 已上传附件（SETTLED）后不可再改明细；
 * ⑤ 乐观锁：version 不匹配 → 冲突；
 * ⑥ 月度结算超过 36 期 → 生成即 400（防"能建单却导不出"的僵尸单据）；
 * ⑦ 审减金额非法值 → 400（不静默归 0）；
 * ⑧ 审减金额大于合计 → 400（防审定金额为负）。
 */
describe('集成 · 总结算单 生成/编辑明细/编号', () => {
  let ctx: IntContext;
  let svc: FinalSettlementService;

  const month = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 15));
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

  /** 建一个带分公司简称的项目 + 合同，并造 3 张非草稿月度结算 */
  async function seed(tag: string) {
    const project = await makeProject(ctx.prisma, tag);
    await ctx.prisma.project.update({
      where: { id: project.id },
      data: { branchCompanyAbbr: 'TMHB', codeAbbr: uniq('AB').replace(/-/g, '').toUpperCase() },
    });
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 3000000,
    });
    const amounts = [393303.28, 660106.39, -61016.78];
    const dates = [month(2025, 2), month(2025, 7), month(2025, 11)];
    for (let i = 0; i < amounts.length; i += 1) {
      await ctx.prisma.settlement.create({
        data: {
          projectId: project.id,
          contractId: contract.id,
          statusCode: SETTLEMENT_STATUS.CONFIRMED,
          amount: amounts[i],
          actualAmount: amounts[i],
          settleDate: dates[i],
        },
      });
    }
    return { project, contract };
  }

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<FinalSettlementService>(FinalSettlementService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('① 生成：明细快照 3 行、合计=明细合计、编号落库', async () => {
    const { project, contract } = await seed('FS-gen');
    const doc: any = await svc.generate(contract.id, project.id, { userId: 'u1' });
    assert.equal(doc.items.length, 3);
    assert.equal(Number(doc.totalAmount), round2(393303.28 + 660106.39 - 61016.78));
    assert.ok(doc.docNumber, '编号应落库');
    assert.match(doc.docNumber, /^TMHB-[A-Z0-9]+-WZZJS-\d{4}-01$/, `编号格式：${doc.docNumber}`);
  });

  it('② 编辑明细 + 审减：重算合计、编号不变', async () => {
    const { project, contract } = await seed('FS-edit');
    const doc: any = await svc.generate(contract.id, project.id, { userId: 'u1' });

    const updated: any = await svc.updateItems(
      doc.id,
      {
        items: [
          { settleMonth: '2026-01', amount: 1000000 },
          { settleMonth: '2026-02', amount: 500000 },
        ],
        reduceAmount: 392.89,
        version: doc.version,
      },
      project.id,
    );
    assert.equal(updated.items.length, 2, '删除旧明细、保留新 2 行');
    assert.equal(Number(updated.totalAmount), 1500000);
    assert.equal(Number(updated.reduceAmount), 392.89);
    assert.equal(updated.docNumber, doc.docNumber, '编辑明细不改编号');
  });

  it('③ 明细超过 36 行 → 400', async () => {
    const { project, contract } = await seed('FS-max');
    const doc: any = await svc.generate(contract.id, project.id, { userId: 'u1' });
    const items = Array.from({ length: 37 }, (_, i) => ({ settleMonth: '2026-01', amount: i + 1 }));
    await assert.rejects(() => svc.updateItems(doc.id, { items, version: doc.version }, project.id), BadRequestException);
  });

  it('④ 已结算（SETTLED）后不可改明细', async () => {
    const { project, contract } = await seed('FS-settled');
    const doc: any = await svc.generate(contract.id, project.id, { userId: 'u1' });
    await ctx.prisma.finalSettlement.update({ where: { id: doc.id }, data: { statusCode: 'SETTLED' } });
    await assert.rejects(
      () => svc.updateItems(doc.id, { items: [{ settleMonth: '2026-01', amount: 1 }], version: doc.version }, project.id),
      BadRequestException,
    );
  });

  it('⑤ 乐观锁：version 不匹配 → 冲突', async () => {
    const { project, contract } = await seed('FS-ver');
    const doc: any = await svc.generate(contract.id, project.id, { userId: 'u1' });
    await assert.rejects(
      () =>
        svc.updateItems(
          doc.id,
          { items: [{ settleMonth: '2026-01', amount: 1 }], version: doc.version + 99 },
          project.id,
        ),
      ConflictException,
    );
  });

  it('⑥ 生成：月度结算超过 36 期 → 400', async () => {
    const project = await makeProject(ctx.prisma, 'FS-gen-max');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 3000000 });
    for (let i = 0; i < 37; i += 1) {
      await ctx.prisma.settlement.create({
        data: {
          projectId: project.id,
          contractId: contract.id,
          statusCode: SETTLEMENT_STATUS.CONFIRMED,
          amount: 1000,
          actualAmount: 1000,
          settleDate: month(2024 + Math.floor(i / 12), (i % 12) + 1),
        },
      });
    }
    await assert.rejects(() => svc.generate(contract.id, project.id, { userId: 'u1' }), BadRequestException);
  });

  it('⑦ 审减金额非法值 → 400（不静默归 0）', async () => {
    const { project, contract } = await seed('FS-reduce-bad');
    const doc: any = await svc.generate(contract.id, project.id, { userId: 'u1' });
    await assert.rejects(
      () =>
        svc.updateItems(
          doc.id,
          { items: [{ settleMonth: '2026-01', amount: 100 }], reduceAmount: 'abc', version: doc.version },
          project.id,
        ),
      BadRequestException,
    );
  });

  it('⑧ 审减金额大于合计 → 400', async () => {
    const { project, contract } = await seed('FS-reduce-over');
    const doc: any = await svc.generate(contract.id, project.id, { userId: 'u1' });
    await assert.rejects(
      () =>
        svc.updateItems(
          doc.id,
          { items: [{ settleMonth: '2026-01', amount: 100 }], reduceAmount: 500, version: doc.version },
          project.id,
        ),
      BadRequestException,
    );
  });
});
