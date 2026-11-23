// @domains: dashboard, contract
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, uniq, type IntContext } from './helpers';
import { DashboardService } from '../src/modules/dashboard';

/**
 * 集成测试 · **工作台「合同额」按合同链只计一次**（2026-11-23 架构评审 P1）。
 *
 * 改动前：`overview.contractAmount` 与 `contractType` 都是 `SUM(Contract.amount)` 裸加所有合同行，
 * 而补充协议的 `amount` 是**手填自由值**（涨价场景常填「剩余数量 × 新价」）。后果：
 * - 同一项目的「合同额」在看板与台账（按链根算）不相等；
 * - 「各类型金额之和」与「合同总额」也不相等。
 *
 * 本文件锁五条：
 * ① 无补充协议时口径与旧实现等价（不改变绝大多数项目的数字）；
 * ② 有补充协议时 = 主合同 + Σ`changeAmount`，**且忽略补充协议的手填 `amount`**；
 * ③ 草稿补充协议（`changeAmount` 为空）贡献 **0**，不会把草稿金额算进总额；
 * ④ `contractType` 按**链根类型**归桶，各桶金额之和 == `overview.contractAmount`；
 * ⑤ 断链（父合同 id 不存在）按「自己是链根」计入，不漏计也不重复计。
 */
describe('集成 · 工作台合同额（链口径）', () => {
  let ctx: IntContext;
  let svc: DashboardService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<DashboardService>(DashboardService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 合同类型字段对读路径没有字典校验，但要有值才能验证「按类型归桶」 */
  async function setType(id: string, typeCode: string) {
    await ctx.prisma.contract.update({ where: { id }, data: { typeCode } as any });
  }

  it('① 无补充协议：口径与旧实现等价', async () => {
    const project = await makeProject(ctx.prisma, 'DB-1');
    const a = await makeContract(ctx.prisma, { projectId: project.id, amount: 10000 });
    const b = await makeContract(ctx.prisma, { projectId: project.id, amount: 2500.5 });
    await setType(a.id, 'PURCHASE');
    await setType(b.id, 'LEASE');

    const o: any = await svc.overview(project.id, {});
    assert.equal(Number(o.contractAmount), 12500.5, '无补充协议时 = Σ 主合同 amount（与旧实现完全一致）');
    assert.equal(o.contractCount, 2);
    assert.equal(o.contractChainCount, 2, '无补充协议 → 链数 = 行数');
    assert.equal(o.supplementCount, 0);
  });

  it('② 有补充协议：= 主合同 + ΣchangeAmount，忽略手填 amount', async () => {
    const project = await makeProject(ctx.prisma, 'DB-2');
    const main = await makeContract(ctx.prisma, { projectId: project.id, amount: 10000 });
    await setType(main.id, 'PURCHASE');
    // 补充协议：手填 amount 是自由值（涨价场景会填「剩余数量 × 新价」），真正的增量在 changeAmount
    const supp = await makeContract(ctx.prisma, {
      projectId: project.id,
      amount: 999999,
      isSupplement: 'Y',
      parentContractId: main.id,
      changeAmount: 2000,
    });
    await setType(supp.id, 'PURCHASE');

    const o: any = await svc.overview(project.id, {});
    assert.equal(Number(o.contractAmount), 12000, '链口径 = 10000 + 2000；不得把 999999 计入');
    assert.equal(o.contractCount, 2, '行数口径未变（含补充协议）');
    assert.equal(o.contractChainCount, 1, '两条行属于同一条链');
    assert.equal(o.supplementCount, 1);
  });

  it('③ 草稿补充协议（changeAmount 为空）贡献 0', async () => {
    const project = await makeProject(ctx.prisma, 'DB-3');
    const main = await makeContract(ctx.prisma, { projectId: project.id, amount: 5000 });
    await makeContract(ctx.prisma, {
      projectId: project.id,
      amount: 8888,
      isSupplement: 'Y',
      parentContractId: main.id,
    });

    const o: any = await svc.overview(project.id, {});
    assert.equal(Number(o.contractAmount), 5000, 'changeAmount 未算出（草稿）→ 不抬高总额');
    assert.equal(o.contractChainCount, 1);
  });

  it('④ 类型分布按链根归桶，各桶之和 == 合同总额', async () => {
    const project = await makeProject(ctx.prisma, 'DB-4');
    const purchase = await makeContract(ctx.prisma, { projectId: project.id, amount: 10000 });
    await setType(purchase.id, 'PURCHASE');
    const lease = await makeContract(ctx.prisma, { projectId: project.id, amount: 3000 });
    await setType(lease.id, 'LEASE');
    // 补充协议自己挂的 typeCode 是 LEASE，但它属于 PURCHASE 那条链 → 金额必须归到 PURCHASE
    const supp = await makeContract(ctx.prisma, {
      projectId: project.id,
      amount: 777,
      isSupplement: 'Y',
      parentContractId: purchase.id,
      changeAmount: 1500,
    });
    await setType(supp.id, 'LEASE');

    const [o, types] = await Promise.all([svc.overview(project.id, {}), svc.contractType(project.id)]);
    const sum = (types as any[]).reduce((s, t) => s + Number(t.amount || 0), 0);
    assert.equal(Number(sum.toFixed(2)), Number(o.contractAmount), '各类型金额之和必须等于合同总额（改前正是这条不成立）');

    const byCode = new Map((types as any[]).map((t) => [t.typeCode, t]));
    assert.equal(Number(byCode.get('PURCHASE')!.amount), 11500, 'PURCHASE 链 = 10000 + 1500');
    assert.equal(Number(byCode.get('PURCHASE')!.chainCount), 1);
    assert.equal(Number(byCode.get('LEASE')!.amount), 3000, 'LEASE 链只有它自己 3000');
    // 补充协议行的类型桶：行数照旧计入，金额为 0（它的增量已归链根）
    const leaseBucket: any = byCode.get('LEASE');
    assert.equal(leaseBucket.count, 2, 'LEASE 桶的行数含那 1 份补充协议（count 口径未变）');
  });

  it('⑤ 父合同在别项目（本项目行集里缺失）→ 当自己是链根计入，不漏不重', async () => {
    // 真正的「悬空 parentContractId」被外键挡住了（Contract_parentContractId_fkey），
    // 能出现的断链形态是：父合同存在但**不在本项目**（跨项目指父 / 父合同所在行集被项目过滤掉）。
    const mine = await makeProject(ctx.prisma, 'DB-5A');
    const other = await makeProject(ctx.prisma, 'DB-5B');
    const parentInOtherProject = await makeContract(ctx.prisma, { projectId: other.id, amount: 99999 });
    await makeContract(ctx.prisma, {
      projectId: mine.id,
      amount: 700,
      changeAmount: 500,
      isSupplement: 'Y',
      parentContractId: parentInOtherProject.id,
    });

    const o: any = await svc.overview(mine.id, {});
    // 本项目只看得到这一行 → 走到「父级不在集合里」分支（broken），按自己是链根：
    // 计入它自己的 amount（700），**不能**因为找不到父行就漏计，也不能去借用别项目的金额。
    assert.equal(Number(o.contractAmount), 700, '断链按自身金额计入，且不掺别项目的数据');
    assert.equal(o.contractChainCount, 1);
    assert.equal(o.contractCount, 1);

    // 别项目不受影响：它自己的链金额仍是 99999
    const otherOverview: any = await svc.overview(other.id, {});
    assert.equal(Number(otherOverview.contractAmount), 99999);
  });
});
