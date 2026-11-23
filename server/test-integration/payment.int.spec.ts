// @domains: payment, contract
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, uniq, type IntContext } from './helpers';
import { PaymentService } from '../src/modules/payment';

/**
 * 集成测试 · **付款登记写路径**（此前零集成覆盖）。
 *
 * 付款是资金链上唯一"由人手工录入金额"的入口，口径错会直接体现在
 * 台账「累计付款」、看板与防超付闸门三处。这里锁四条真库契约：
 *
 * ① 防超付闸门：默认策略 `WARN` —— 超过「累计结算」只**提示**不拦（返回 `overAmountWarning`），
 *    而不是静默通过（该提示会被前端展示）；
 * ② 非出资状态（`FAILED`/`REFUNDED`）既不计入累计付款，也不参与超付判定；
 * ③ `payMonth` 必须是 `YYYY-MM`（口径：台账/看板按字符串精确匹配月份，
 *    非规范值会让该笔付款在所有月度统计里**消失**）；
 * ④ 项目隔离 + 乐观锁：别项目合同 400；`updateRecord` 缺 version → 409。
 */
describe('集成 · 付款登记写路径', () => {
  let ctx: IntContext;
  let svc: PaymentService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<PaymentService>(PaymentService);
  });
  after(async () => {
    await ctx.app.close();
  });

  const base = (contractId: string, extra: Record<string, any> = {}) => ({
    contractId,
    payMonth: '2026-09',
    amount: 100,
    methodCode: 'TRANSFER',
    statusCode: 'PAID',
    payDate: '2026-09-15',
    ...extra,
  });

  it('① 超付只提示不拦（默认 WARN）：返回 overAmountWarning', async () => {
    const project = await makeProject(ctx.prisma, 'PAY-OVER');
    // 该合同没有任何结算单 → 累计结算 = 0，付任何金额都"超付"
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });

    const rec: any = await svc.createRecord(base(contract.id), project.id);
    assert.equal(Number(rec.amount), 100);
    assert.ok(rec.overAmountWarning, '默认 WARN 策略下必须回提示（不能静默通过）');
    assert.match(String(rec.overAmountWarning), /付款/);
  });

  it('② 非出资状态（FAILED）不参与超付判定', async () => {
    const project = await makeProject(ctx.prisma, 'PAY-FAIL');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });

    const rec: any = await svc.createRecord(base(contract.id, { statusCode: 'FAILED' }), project.id);
    assert.equal(rec.overAmountWarning, undefined, '失败付款不构成实际出资，不该报超付');
  });

  it('③ 付款月份必须是 YYYY-MM', async () => {
    const project = await makeProject(ctx.prisma, 'PAY-MONTH');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });

    // 注意：空串不在本用例覆盖范围——共享助手 `assertYearMonth` 对空值放行
    // （它同时服务「结算月份可空」的调用方）；空 payMonth 的缺口登记在 TODO.md。
    for (const bad of ['2026-9', '2026/09', '202609', '2026-13']) {
      await assert.rejects(
        () => svc.createRecord(base(contract.id, { payMonth: bad }), project.id),
        (e: any) => e instanceof BadRequestException,
        `非法付款月份「${bad}」必须 400`,
      );
    }
  });

  it('④ 项目隔离：别项目合同 400（防把供应商开户行/账号跨项目带出）', async () => {
    const mine = await makeProject(ctx.prisma, 'PAY-P1');
    const other = await makeProject(ctx.prisma, 'PAY-P2');
    const otherContract = await makeContract(ctx.prisma, { projectId: other.id, amount: 1000 });

    await assert.rejects(
      () => svc.createRecord(base(otherContract.id), mine.id),
      (e: any) => e instanceof BadRequestException && /不属于当前项目/.test(e.message),
      '跨项目挂合同的付款必须被拦',
    );
  });

  it('⑤ 乐观锁：updateRecord 缺 version → 409；正常改逐字段生效', async () => {
    const project = await makeProject(ctx.prisma, 'PAY-LOCK');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });
    const rec: any = await svc.createRecord(base(contract.id), project.id);

    await assert.rejects(
      () => svc.updateRecord(rec.id, { amount: 200 }, project.id),
      (e: any) => e instanceof ConflictException,
      '省略 version 必须拒绝',
    );

    const updated: any = await svc.updateRecord(rec.id, { amount: 200, version: rec.version, methodCode: 'TRANSFER', statusCode: 'PAID', payMonth: '2026-09' }, project.id);
    assert.equal(Number(updated.amount), 200);
    assert.ok(updated.version > rec.version, 'version 必须自增');
  });
});
