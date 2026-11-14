import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, makeSupplier, type IntContext } from './helpers';
import { LedgerService } from '../src/modules/ledger';
import { SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · 合同台账的派生金额口径（真库）。
 *
 * 纯函数单测（`ledgerDerived.spec.mts`）证明算式本身；这里证明 **service 真的接上了**：
 * ① 项目「合同额」合计按**链**只计一次（补充协议行的自由 `amount` 不参与相加）；
 * ② 「审定结算额」排除草稿、`actualAmount` 为空时回退 `amount`；
 * ③ 税率未填时税前/进项税留 `null`（未知不兜 0%），显式税率正常拆分。
 */
describe('集成 · 台账派生金额口径', () => {
  let ctx: IntContext;
  let ledger: LedgerService;

  before(async () => {
    ctx = await bootIntApp();
    ledger = ctx.get<LedgerService>(LedgerService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('合同额合计按链只计一次：补充协议的自由 amount 不再相加', async () => {
    const project = await makeProject(ctx.prisma, 'LEDGER-1');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const main = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 1000000,
    });
    await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 200000,
      isSupplement: 'Y',
      parentContractId: main.id,
      changeAmount: 50000,
    });

    const summary: any = await ledger.summary(project.id);
    assert.equal(
      summary.contractAmount,
      1050000,
      '主合同 100 万 + 增量 5 万；补充协议的 20 万是自由值，逐行相加会重复计入',
    );
  });

  it('审定结算额排除草稿，并在 actualAmount 为空时回退 amount', async () => {
    const project = await makeProject(ctx.prisma, 'LEDGER-2');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 1000000,
    });
    const base = { projectId: project.id, contractId: contract.id };
    await ctx.prisma.settlement.create({
      data: { ...base, statusCode: SETTLEMENT_STATUS.DRAFT, actualAmount: 300000, settleDate: new Date(2026, 8, 15) },
    });
    await ctx.prisma.settlement.create({
      data: { ...base, statusCode: SETTLEMENT_STATUS.CONFIRMED, actualAmount: 100000, settleDate: new Date(2026, 7, 15) },
    });
    // 历史行：actualAmount 为空、amount 有值 → 回退 amount（与 chainSettledTotal 同口径）
    await ctx.prisma.settlement.create({
      data: {
        ...base,
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 50000,
        actualAmount: null,
        settleDate: new Date(2026, 6, 15),
      },
    });

    const res: any = await ledger.findAll({}, project.id);
    const row = res.list.find((r: any) => r.id === contract.id);
    assert.equal(row.auditedSettleAmount, 150000, '草稿 30 万不计入；已确认 10 万 + 历史 5 万 = 15 万');
  });

  it('税率未填 → 税前/进项税留空；显式 13% 正常拆分', async () => {
    const project = await makeProject(ctx.prisma, 'LEDGER-3');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const noTax = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000000 });
    const taxed = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000000 });
    await ctx.prisma.contract.update({ where: { id: taxed.id }, data: { taxRate: 0.13 } });
    for (const c of [noTax, taxed]) {
      await ctx.prisma.settlementLedger.create({
        data: { projectId: project.id, contractId: c.id, settleMonth: '2026-09', monthSettleAmount: 113000 },
      });
    }

    const res: any = await ledger.findAll({}, project.id);
    const a = res.list.find((r: any) => r.id === noTax.id);
    const b = res.list.find((r: any) => r.id === taxed.id);
    assert.equal(a.cumSettleBeforeTax, null, '税率未填时不该谎称税前 = 含税');
    assert.equal(a.cumInputTax, null, '税率未填时进项税是"未知"，不是 0');
    assert.equal(b.cumSettleBeforeTax, 100000);
    assert.equal(b.cumInputTax, 13000);
  });
});
