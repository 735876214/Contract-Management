import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeSupplier, type IntContext } from './helpers';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { PaymentService } from '../src/modules/payment/payment.service';
import { SysParamService } from '../src/common/services/sys-param.service';
import { PAYMENT_STATUS, SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · **金额上限闸门真的会拦**（不是只测判定函数）。
 *
 * 纯函数单测（`test/amountGuard.spec.mts`）只证明"给定 limit/used/current 时判定正确"，
 * 但闸门是否**接上了**（策略读系统参数、草稿是否豁免、失败/退款是否排除、合同未填金额是否放行）
 * 只有在真库上跑 service 才能证明。这里覆盖：
 * ① BLOCK 策略下超限被 400 拦住；② WARN 策略放行；③ 草稿不受限；
 * ④ **合同未填金额 = 无上限**（历史上的真实缺陷：把"无金额"当上限 0，BLOCK 下拦住所有合法单据）；
 * ⑤ 付款的累计口径排除「付款失败 / 已退款」（上限取累计**结算**）；
 * ⑥ **补充协议的带符号增量真的进上限**（业务口径 2026-10-16：合同当前金额 = 主合同 + Σ changeAmount）——
 *    降价使上限下降、增项使上限回升，且求和用的是 `changeAmount` 而不是补充协议手填的 `amount`。
 */
describe('集成 · 金额上限闸门', () => {
  let ctx: IntContext;
  before(async () => {
    ctx = await bootIntApp();
  });
  after(async () => {
    await ctx.app.close();
  });

  it('结算：BLOCK 拦超结 / WARN 放行 / 草稿豁免 / 无金额不拦', async () => {
    const settle = ctx.get<SettlementService>(SettlementService);
    const sysParam = ctx.get<SysParamService>(SysParamService);
    const project = await makeProject(ctx.prisma, 'GUARD-C');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    /**
     * ⚠️ 每笔用**不同月份**：2026-10-16 起「同合同同月只允许一张结算单」
     * （台账改为"一结算单对应一行"，同月两张无法归属发票/资金费用），
     * 同月再建会被 400 拦住——那会盖住本用例真正要验的"累计超结"。
     */
    const payloadOfMonth = (monthIdx: number) => ({
      contractId: contract.id,
      typeCode: 'PROGRESS',
      statusCode: SETTLEMENT_STATUS.PENDING,
      amount: 60000,
      settleDate: new Date(2026, monthIdx, 15),
    });

    await sysParam.set('settlement.over_amount_policy', 'BLOCK');
    const first = await settle.create({ ...payloadOfMonth(0) }, project.id);
    assert.ok(first?.id, '首笔（未超限）应写入成功');

    await assert.rejects(
      () => settle.create({ ...payloadOfMonth(1) }, project.id),
      (e: any) => e instanceof BadRequestException && /超过/.test(e.message),
      '累计 12 万 > 上限 10 万，BLOCK 下应被 400 拦住',
    );

    await sysParam.set('settlement.over_amount_policy', 'WARN');
    const warned = await settle.create({ ...payloadOfMonth(2) }, project.id);
    assert.ok(warned?.id, 'WARN 策略应放行');

    await sysParam.set('settlement.over_amount_policy', 'BLOCK');
    const draft = await settle.create({ ...payloadOfMonth(3), statusCode: SETTLEMENT_STATUS.DRAFT }, project.id);
    assert.ok(draft?.id, '草稿不受上限约束（且不计入累计）');

    // 合同未填金额 → 上限为 null（不可校验）→ BLOCK 下也必须放行
    const noAmount = await makeContract(ctx.prisma, { projectId: project.id, amount: null });
    const ok = await settle.create({ ...payloadOfMonth(4), contractId: noAmount.id }, project.id);
    assert.ok(ok?.id, '合同未填金额时不得拦截（回归：曾把"无金额"当上限 0）');

    await sysParam.set('settlement.over_amount_policy', 'WARN');
  });

  it('付款：BLOCK 拦超付；失败/已退款不计入累计', async () => {
    const settle = ctx.get<SettlementService>(SettlementService);
    const payment = ctx.get<PaymentService>(PaymentService);
    const sysParam = ctx.get<SysParamService>(SysParamService);
    const project = await makeProject(ctx.prisma, 'GUARD-P');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 100000 });

    await settle.create(
      {
        contractId: contract.id,
        typeCode: 'PROGRESS',
        statusCode: SETTLEMENT_STATUS.CONFIRMED,
        amount: 50000,
        settleDate: new Date(),
      },
      project.id,
    );

    // 上限 = 累计结算 5 万
    await sysParam.set('payment.over_amount_policy', 'BLOCK');
    await assert.rejects(
      () =>
        payment.createRecord(
          {
            contractId: contract.id,
            amount: 80000,
            statusCode: PAYMENT_STATUS.PAID,
            methodCode: 'TRANSFER',
            payDate: new Date(),
          },
          project.id,
        ),
      (e: any) => e instanceof BadRequestException && /超过/.test(e.message),
      '付款 8 万 > 累计结算 5 万，BLOCK 下应被拦住',
    );

    // 付款失败 / 已退款：不参与累计，故可自由录入
    for (const status of [PAYMENT_STATUS.FAILED, PAYMENT_STATUS.REFUNDED]) {
      const rec = await payment.createRecord(
        { contractId: contract.id, amount: 90000, statusCode: status, methodCode: 'TRANSFER', payDate: new Date() },
        project.id,
      );
      assert.ok(rec?.id, `${status} 不计入累计，不应被拦`);
    }

    // 正常付款 4 万（累计已付 0 + 4 万 ≤ 5 万）→ 放行
    const okPay = await payment.createRecord(
      { contractId: contract.id, amount: 40000, statusCode: PAYMENT_STATUS.PAID, methodCode: 'TRANSFER', payDate: new Date() },
      project.id,
    );
    assert.ok(okPay?.id, '未超累计结算的正常付款应放行');

    // 再付 2 万 → 累计已付 6 万 > 5 万 → 拦住
    await assert.rejects(
      () =>
        payment.createRecord(
          { contractId: contract.id, amount: 20000, statusCode: PAYMENT_STATUS.PAID, methodCode: 'TRANSFER', payDate: new Date() },
          project.id,
        ),
      (e: any) => e instanceof BadRequestException && /超过/.test(e.message),
    );

    await sysParam.set('payment.over_amount_policy', 'WARN');
  });
  it('补充协议带符号增量进上限：降价 → 上限下降拦住原本合法的单；增项 → 上限回升放行', async () => {
    const settle = ctx.get<SettlementService>(SettlementService);
    const sysParam = ctx.get<SysParamService>(SysParamService);
    const project = await makeProject(ctx.prisma, 'GUARD-DELTA');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const main = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 100000,
    });
    await sysParam.set('settlement.over_amount_policy', 'BLOCK');

    const payload = {
      contractId: main.id,
      typeCode: 'PROGRESS',
      statusCode: SETTLEMENT_STATUS.PENDING,
      amount: 70000,
      settleDate: new Date(),
    };

    // 降价补充协议：changeAmount = −40000 → 合同当前金额 60000。
    // ⚠️ amount 故意填一个**很大的数**：若闸门误用补充协议的 amount 求和，上限会变成 100000+500000，
    // 这笔 7 万就会被放行 —— 这正是本用例要挡住的回归。
    await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 500000,
      isSupplement: 'Y',
      parentContractId: main.id,
      supplementTypeCode: 'PRICE_DOWN',
      changeAmount: -40000,
    });

    await assert.rejects(
      () => settle.create({ ...payload }, project.id),
      (e: any) => e instanceof BadRequestException && /超过/.test(e.message),
      '降价使当前金额降到 6 万，7 万结算在 BLOCK 下应被拦住',
    );

    // 再加一份增项 +40000 → 当前金额回到 100000 → 同一笔应放行
    await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 1,
      isSupplement: 'Y',
      parentContractId: main.id,
      supplementTypeCode: 'QTY_ADD',
      changeAmount: 40000,
    });
    const ok = await settle.create({ ...payload }, project.id);
    assert.ok(ok?.id, '增项把当前金额抬回 10 万后，7 万结算应放行');
  });

});
