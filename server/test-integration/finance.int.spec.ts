// @domains: finance, contract
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, uniq, type IntContext } from './helpers';
import { FinanceService } from '../src/modules/finance';

/**
 * 集成测试 · **资金参数与逾期应付写路径**（此前零集成覆盖，finance.service 近千行）。
 *
 * 这条链是"金额口径"最容易漂移的地方：合同上的利率/宽限期/付款安排既是
 * 逾期利息引擎的输入，也是台账「当前生效比例」的派生来源。锁定五条真库契约：
 *
 * ① `contractParams()` 回落：合同未设置时取系统参数默认（月利率/宽限期/上限比例），
 *    `overrides` 只回显**合同上真填过的值**（null 表示走默认，不能回填成默认值后又被当成"已设置"）；
 * ② 写入校验：月利率必须正数、宽限期必须非负整数、付款安排必须在可选范围内 —— 全部 400；
 * ③ 归档锁：已归档合同禁止改资金参数（`archivedAt` 非空 → 400）；
 * ④ 项目隔离：别项目合同一律按「合同不存在」404（不给存在性信标）；
 * ⑤ 按付款安排生成应付款：`100` 模式 = 一期、比例 100%、材料款不拆分。
 */
describe('集成 · 资金参数与逾期应付', () => {
  let ctx: IntContext;
  let svc: FinanceService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<FinanceService>(FinanceService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 台账同步依赖项目的结算起算日，缺了会让月份集合为空 */
  async function projectWithStart(tag: string) {
    const project = await makeProject(ctx.prisma, tag);
    await ctx.prisma.project.update({
      where: { id: project.id },
      data: { settlementStartDate: new Date('2026-01-01T00:00:00Z') } as any,
    });
    return project;
  }

  it('① 合同未设置资金参数时回落到系统默认值，overrides 为空', async () => {
    const project = await projectWithStart('FIN-DEF');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });

    const p: any = await svc.contractParams(contract.id, project.id);
    assert.equal(p.paymentMode, '100', '未设置时默认按 100% 次月付');
    assert.equal(Number(p.monthlyRate), 0.006, '月利率回落系统参数');
    assert.equal(Number(p.graceDays), 7, '宽限期回落系统参数');
    assert.equal(Number(p.interestCapRatio), 0.05, '利息上限比例回落系统参数');
    assert.deepEqual(
      p.overrides,
      { monthlyRate: null, graceDays: null, interestCapRatio: null, paymentMode: null },
      'overrides 必须只反映合同上真填过的值',
    );
  });

  it('② 写入校验：月利率/宽限期/付款安排非法一律 400', async () => {
    const project = await projectWithStart('FIN-VALID');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });

    await assert.rejects(
      () => svc.updateContractParams(contract.id, { monthlyRate: 0 }, project.id),
      (e: any) => e instanceof BadRequestException && /月利率/.test(e.message),
      '月利率 0 会让利息变 0，必须拦',
    );
    await assert.rejects(
      () => svc.updateContractParams(contract.id, { monthlyRate: -0.01 }, project.id),
      (e: any) => e instanceof BadRequestException && /月利率/.test(e.message),
      '负利率会算出负利息',
    );
    await assert.rejects(
      () => svc.updateContractParams(contract.id, { graceDays: 1.5 }, project.id),
      (e: any) => e instanceof BadRequestException && /宽限期/.test(e.message),
      '宽限期必须非负整数',
    );
    await assert.rejects(
      () => svc.updateContractParams(contract.id, { paymentMode: 'NOT_A_MODE' as any }, project.id),
      (e: any) => e instanceof BadRequestException && /付款安排/.test(e.message),
      '付款安排必须在可选范围内（否则派生比例与逾期引擎都取不到分期）',
    );

    // 合规写入：值落到合同行并可读回，overrides 同步
    const ok: any = await svc.updateContractParams(contract.id, { monthlyRate: 0.01, graceDays: 10 }, project.id);
    assert.equal(Number(ok.monthlyRate), 0.01);
    assert.equal(Number(ok.graceDays), 10);
    assert.equal(Number(ok.overrides.monthlyRate), 0.01, 'overrides 应回显合同上真填的值');
  });

  it('③ 归档锁：已归档合同禁止改资金参数', async () => {
    const project = await projectWithStart('FIN-ARCH');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });
    await ctx.prisma.contract.update({ where: { id: contract.id }, data: { archivedAt: new Date() } as any });

    await assert.rejects(
      () => svc.updateContractParams(contract.id, { monthlyRate: 0.02 }, project.id),
      (e: any) => e instanceof BadRequestException && /归档/.test(e.message),
    );
  });

  it('④ 项目隔离：别项目合同按「合同不存在」404', async () => {
    const mine = await projectWithStart('FIN-P1');
    const other = await projectWithStart('FIN-P2');
    const otherContract = await makeContract(ctx.prisma, { projectId: other.id, amount: 1000 });

    await assert.rejects(
      () => svc.contractParams(otherContract.id, mine.id),
      (e: any) => e instanceof NotFoundException && /合同不存在/.test(e.message),
      '跨项目读资金参数必须 404（不暴露"存在但不属于你"）',
    );
    await assert.rejects(
      () => svc.updateContractParams(otherContract.id, { monthlyRate: 0.02 }, mine.id),
      (e: any) => e instanceof NotFoundException,
      '跨项目写同样 404',
    );
  });

  it('⑤ 按付款安排生成应付款：100 模式 = 一期、比例 100%', async () => {
    const project = await projectWithStart('FIN-GEN');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 100000 });

    const created: any[] = await svc.generateOverdueRows(contract.id, '2026-09', 50000, project.id);
    assert.equal(created.length, 1, '100 模式只有一期');
    assert.equal(Number(created[0].materialAmount), 50000, '材料款不拆分');
    assert.equal(Number(created[0].paymentRatio), 1, '比例 100%');
    assert.equal(created[0].settlementMonth, '2026-09');

    // 读取走同一套重算引擎：列表能取到这一期，且合计与落库一致
    const view: any = await svc.listOverdue(contract.id, {}, project.id);
    assert.equal(view.total, 1);
    assert.equal(Number(view.list[0].materialAmount), 50000);
  });
});
