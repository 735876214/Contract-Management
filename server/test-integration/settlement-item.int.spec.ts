import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeSupplier, uniq, type IntContext } from './helpers';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { SysParamService } from '../src/common/services/sys-param.service';
import { SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · **清单项级结算明细 + 量级校验**（业务 2026-10-17）。
 *
 * 纯函数单测证明不了"闸门是否真的接上了"，这里在真库上验：
 * ① 结算单随 body 带 items → 明细落库、价格由服务端重算（综合单价/合价不信任前端）；
 * ② update 整体替换明细（replace-all 语义）；
 * ③ **量级闸门**：Σ明细量 + 历史已结 ＞ 链上清单量 → BLOCK 拦 400 / WARN 返回 overQtyWarning；
 * ④ 链上无清单行的物资 = 无上限，不拦；
 * ⑤ 草稿不校验量级。
 */
describe('集成 · 清单项级结算明细 + 量级校验', () => {
  let ctx: IntContext;
  let settle: SettlementService;
  let sysParam: SysParamService;

  const month = (y: number, m: number) => new Date(y, m - 1, 15);

  /** 建一个物资基础记录 + 合同清单行（qty 为链上清单量上限） */
  async function makeMaterialWithQty(projectId: string, contractId: string, qty: number, name: string) {
    const base = await ctx.prisma.materialBase.create({
      data: { name, spec: uniq('SPEC'), unit: 'T', isAsset: false, isSafetyMaterial: false, status: 1 },
    });
    await ctx.prisma.contractMaterial.create({
      data: { contractId, materialBaseId: base.id, unit: 'T', qty },
    });
    void projectId;
    return base;
  }

  before(async () => {
    ctx = await bootIntApp();
    settle = ctx.get<SettlementService>(SettlementService);
    // 量级闸门策略经由 SysParamService 改（它有进程内缓存，绕过它直改 DB 不会生效）
    sysParam = ctx.get<SysParamService>(SysParamService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('① items 随结算单落库，价格由服务端重算（合价 = qty × 综合单价）', async () => {
    const project = await makeProject(ctx.prisma, 'SITEM-1');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const base = await makeMaterialWithQty(project.id, contract.id, 1000, '钢筋');

    const s: any = await settle.create(
      {
        contractId: contract.id,
        typeCode: 'PROGRESS',
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 1000,
        settleDate: month(2026, 5),
        items: [{ materialBaseId: base.id, qty: 10, priceBeforeTax: 100, taxRatePct: 13 }],
      },
      project.id,
    );
    const rows = await ctx.prisma.settlementItem.findMany({ where: { settlementId: s.id } });
    assert.equal(rows.length, 1, '明细应落库');
    assert.equal(Number(rows[0].qty), 10);
    assert.equal(Number(rows[0].priceWithTax), 113, '综合单价 = 100 × 1.13（服务端算）');
    assert.equal(Number(rows[0].totalWithTax), 1130, '合价 = 10 × 113（服务端算）');
  });

  it('② update 整体替换明细（replace-all）', async () => {
    const project = await makeProject(ctx.prisma, 'SITEM-2');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const b1 = await makeMaterialWithQty(project.id, contract.id, 1000, '水泥');
    const b2 = await makeMaterialWithQty(project.id, contract.id, 1000, '砂石');

    const s: any = await settle.create(
      {
        contractId: contract.id,
        typeCode: 'PROGRESS',
        statusCode: SETTLEMENT_STATUS.DRAFT,
        amount: 0,
        settleDate: month(2026, 6),
        items: [{ materialBaseId: b1.id, qty: 5, priceBeforeTax: 100, taxRatePct: 13 }],
      },
      project.id,
    );
    await settle.update(s.id, {
      version: 0,
      items: [
        { materialBaseId: b1.id, qty: 8, priceBeforeTax: 100, taxRatePct: 13 },
        { materialBaseId: b2.id, qty: 2, priceBeforeTax: 50, taxRatePct: 13 },
      ],
    });
    const rows = await ctx.prisma.settlementItem.findMany({ where: { settlementId: s.id } });
    assert.equal(rows.length, 2, 'replace-all：删除旧行重建');
    assert.ok(rows.some((r) => r.materialBaseId === b2.id && Number(r.qty) === 2));
  });

  it('③ 量级闸门：WARN 策略下超量返回 overQtyWarning，BLOCK 策略下 400', async () => {
    const project = await makeProject(ctx.prisma, 'SITEM-3');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const base = await makeMaterialWithQty(project.id, contract.id, 100, '混凝土');

    // 显式归位 WARN（前次半程崩溃可能把参数留在 BLOCK）
    await sysParam.set('settlement.over_amount_policy', 'WARN');

    // WARN（默认）：不拦但带警示
    const warned: any = await settle.create(
      {
        contractId: contract.id,
        typeCode: 'PROGRESS',
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 1000,
        settleDate: month(2026, 7),
        items: [{ materialBaseId: base.id, qty: 150, priceBeforeTax: 400, taxRatePct: 13 }],
      },
      project.id,
    );
    assert.ok(warned?.overQtyWarning, 'WARN 策略应返回 overQtyWarning');
    assert.match(warned.overQtyWarning, /超过合同清单量/);

    // BLOCK：改系统参数后拦 400
    await sysParam.set('settlement.over_amount_policy', 'BLOCK');
    try {
      await assert.rejects(
        () =>
          settle.create(
            {
              contractId: contract.id,
              typeCode: 'PROGRESS',
              statusCode: SETTLEMENT_STATUS.CONFIRMED,
              amount: 1000,
              settleDate: month(2026, 8),
              items: [{ materialBaseId: base.id, qty: 10, priceBeforeTax: 400, taxRatePct: 13 }],
            },
            project.id,
          ),
        (e: any) => e instanceof BadRequestException && /超过合同清单量/.test(e.message),
        'BLOCK 策略下（历史已结 150 + 本单 10 ＞ 清单 100）应 400',
      );
    } finally {
      await sysParam.set('settlement.over_amount_policy', 'WARN');
    }
  });

  it('④ 链上无清单行的物资 = 无上限，不拦', async () => {
    const project = await makeProject(ctx.prisma, 'SITEM-4');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    // 有清单但只建 10，物资 B 无清单行
    const withBase = await makeMaterialWithQty(project.id, contract.id, 10, '有清单物资');
    const freeBase = await ctx.prisma.materialBase.create({
      data: { name: uniq('无清单物资'), spec: uniq('FREE'), unit: 'T', isAsset: false, isSafetyMaterial: false, status: 1 },
    });

    const s: any = await settle.create(
      {
        contractId: contract.id,
        typeCode: 'PROGRESS',
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 1000,
        settleDate: month(2026, 9),
        items: [
          { materialBaseId: freeBase.id, qty: 99999, priceBeforeTax: 1, taxRatePct: 0 },
          { materialBaseId: withBase.id, qty: 5, priceBeforeTax: 1, taxRatePct: 0 },
        ],
      },
      project.id,
    );
    assert.ok(!s?.overQtyWarning, '无清单行的物资不应触发量级警示（有清单行 5 ≤ 10 也未超）');
  });

  it('⑤ 草稿不校验量级（超量草稿可保存，提交时才拦）', async () => {
    const project = await makeProject(ctx.prisma, 'SITEM-5');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });
    const base = await makeMaterialWithQty(project.id, contract.id, 10, '限量物资');

    const s: any = await settle.create(
      {
        contractId: contract.id,
        typeCode: 'PROGRESS',
        statusCode: SETTLEMENT_STATUS.DRAFT,
        amount: 1000,
        settleDate: month(2026, 10),
        items: [{ materialBaseId: base.id, qty: 500, priceBeforeTax: 1, taxRatePct: 0 }],
      },
      project.id,
    );
    assert.ok(s?.id, '草稿超量不应被拦');
    assert.ok(!s?.overQtyWarning, '草稿不做量级校验，也不应带警示');
  });
});
