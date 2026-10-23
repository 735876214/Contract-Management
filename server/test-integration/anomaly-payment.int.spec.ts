import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, makeSupplier, uniq, type IntContext } from './helpers';
import { AnomalyService } from '../src/modules/ai/anomaly/anomaly.service';
import { PAYMENT_STATUS, SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · **结算/付款异常预警在真库上的口径**（`docs/AI应用落地计划.md` §4.5 承诺但一直缺的那个 spec）。
 *
 * 为什么必须有它：`server/test/aiAnomalyPayment.spec.mts` 锁的是**手搓夹具**，
 * 2026-10-23 审计的根因正是「夹具形状 ≠ 真实落库形状」——链根解析、累计口径、
 * 区间边界这些问题只有走真 Prisma 查询才暴露得出来。这里每条用例都对应一个真实缺陷：
 *
 * ① R1-b 的清单量按**合同链根**归集（结算挂母合同、清单在母合同，累计已结跨到补充协议）；
 * ② 面板按补充协议下钻时，服务端先把整条链展开再取数（否则链被切断、清单量取不到）；
 * ③ R2 的付款按**链根**归集（结算挂母合同、付款记补充协议不得报「超付」）；
 * ④ R2 真的超付时要报出来，且事实里是链级累计口径；
 * ⑤ 区间上界按**当日 23:59:59.999**（库里日期带时分时，当天下午的付款不能丢）。
 */

const INT_USER = { userId: 'int-anomaly-user', username: 'int-anomaly', permissions: ['contract:view'] } as any;

/** 2026-06-15 14:30 本地时间：带时分的付款日（导入数据常见） */
const AT_1430 = new Date(2026, 5, 15, 14, 30, 0);

describe('集成 · 结算/付款异常预警（真库口径）', () => {
  let ctx: IntContext;
  let svc: AnomalyService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<AnomalyService>(AnomalyService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 物资基础记录 + 合同清单行（链上清单量上限） */
  async function materialRow(contractId: string, qty: number, name: string) {
    const base = await ctx.prisma.materialBase.create({
      data: { name, spec: uniq('SPEC'), unit: 'T', isAsset: false, isSafetyMaterial: false, status: 1 },
    });
    await ctx.prisma.contractMaterial.create({ data: { contractId, materialBaseId: base.id, unit: 'T', qty } });
    return base;
  }

  async function settlementRow(params: {
    projectId: string;
    contractId: string;
    amount: number;
    settleDate: Date;
    statusCode?: string;
  }) {
    return ctx.prisma.settlement.create({
      data: {
        projectId: params.projectId,
        contractId: params.contractId,
        code: uniq('INT-ST'),
        typeCode: 'PROGRESS',
        amount: params.amount,
        actualAmount: params.amount,
        settleDate: params.settleDate,
        statusCode: params.statusCode ?? SETTLEMENT_STATUS.CONFIRMED,
      } as any,
    });
  }

  async function settlementItemRow(settlementId: string, materialBaseId: string, qty: number, unitPrice = 100) {
    await ctx.prisma.settlementItem.create({
      data: {
        settlementId,
        materialBaseId,
        qty,
        priceBeforeTax: unitPrice,
        taxRatePct: 13,
        priceWithTax: unitPrice * 1.13,
        totalWithTax: Math.round(qty * unitPrice * 1.13 * 100) / 100,
      } as any,
    });
  }

  async function paymentRow(params: {
    projectId: string;
    contractId: string | null;
    amount: number;
    payDate: Date;
    statusCode?: string;
  }) {
    return ctx.prisma.paymentRecord.create({
      data: {
        projectId: params.projectId,
        contractId: params.contractId,
        payMonth: `${params.payDate.getFullYear()}-${String(params.payDate.getMonth() + 1).padStart(2, '0')}`,
        amount: params.amount,
        payDate: params.payDate,
        statusCode: params.statusCode ?? PAYMENT_STATUS.PAID,
      } as any,
    });
  }

  /** 建一条「母合同（已签 + 付款比例 80%）+ 补充协议」的链 */
  async function makeChain(tag: string, opts: { ratio?: number } = {}) {
    const project = await makeProject(ctx.prisma, tag);
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const root = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 1000,
      status: 'SIGNED',
    });
    const sub = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: 0,
      status: 'SIGNED',
      isSupplement: 'Y',
      parentContractId: root.id,
      changeAmount: 0,
    });
    await ctx.prisma.contractExt.create({
      data: { contractId: root.id, currentPayRatio: opts.ratio ?? 0.8 } as any,
    });
    return { project, supplier, root, sub };
  }

  const period = { from: '2026-06-01', to: '2026-06-30', narrative: '0' };

  it('① R1-b：清单量按合同链根归集，累计已结跨补充协议也能比对出来', async () => {
    const { project, root, sub } = await makeChain('ANOM-1');
    const base = await materialRow(root.id, 300, '钢筋'); // 链上清单量 300
    const s1 = await settlementRow({ projectId: project.id, contractId: root.id, amount: 250, settleDate: new Date(2026, 5, 10) });
    await settlementItemRow(s1.id, base.id, 250);
    const s2 = await settlementRow({ projectId: project.id, contractId: sub.id, amount: 250, settleDate: new Date(2026, 5, 20) });
    await settlementItemRow(s2.id, base.id, 250); // 累计已结 500 > 300

    const res = await svc.payment(period as any, project.id, INT_USER);
    const hit = res.findings.find((f) => f.code === 'R1_DUP_MATERIAL_QTY');
    assert.ok(hit, `应报「清单项累计超结」，实际命中：${res.findings.map((f) => f.code).join(',')}`);
    const facts = JSON.stringify(hit!.facts);
    assert.ok(facts.includes('300'), `事实里应有链上清单量 300，实际：${facts}`);
    assert.ok(facts.includes('500'), `事实里应有累计已结量 500，实际：${facts}`);
    // M6：实体用合同编号，不是 id 前 8 位
    assert.ok(facts.includes(root.code), `事实里应用合同编号 ${root.code}，实际：${facts}`);
  });

  it('② 按补充协议下钻：服务端展开整条链，链口径结论与全项目一致', async () => {
    const { project, root, sub } = await makeChain('ANOM-2');
    const base = await materialRow(root.id, 300, '水泥');
    const s1 = await settlementRow({ projectId: project.id, contractId: root.id, amount: 250, settleDate: new Date(2026, 5, 10) });
    await settlementItemRow(s1.id, base.id, 250);
    const s2 = await settlementRow({ projectId: project.id, contractId: sub.id, amount: 250, settleDate: new Date(2026, 5, 20) });
    await settlementItemRow(s2.id, base.id, 250);

    const whole = await svc.payment(period as any, project.id, INT_USER);
    const drill = await svc.payment({ ...period, contractId: sub.id } as any, project.id, INT_USER);

    assert.ok(
      whole.findings.some((f) => f.code === 'R1_DUP_MATERIAL_QTY'),
      '全项目查询应命中超结',
    );
    assert.ok(
      drill.findings.some((f) => f.code === 'R1_DUP_MATERIAL_QTY'),
      `下钻到补充协议也应命中（链被展开），实际命中：${drill.findings.map((f) => f.code).join(',')}`,
    );
    assert.ok(
      !drill.notEvaluated.some((t) => t.includes('R1-b') && t.includes('没有合同清单量')),
      `下钻时不该说「没有合同清单量」（链上有），实际未判定：${drill.notEvaluated.join(' / ')}`,
    );
  });

  it('③ R2：结算挂母合同、付款记补充协议，不得误报「超付」（付款按链根归集）', async () => {
    const { project, root, sub } = await makeChain('ANOM-3', { ratio: 0.8 });
    await settlementRow({ projectId: project.id, contractId: root.id, amount: 1000, settleDate: new Date(2026, 5, 10) });
    await paymentRow({ projectId: project.id, contractId: sub.id, amount: 500, payDate: new Date(2026, 5, 12) });
    // 上限 = 1000 × 0.8 = 800，已付 500 → 不超付

    const res = await svc.payment(period as any, project.id, INT_USER);
    assert.equal(
      res.findings.filter((f) => f.code === 'R2_OVERPAY').length,
      0,
      `付款 500 ≤ 上限 800，不该报超付；实际：${JSON.stringify(res.findings.map((f) => f.facts))}`,
    );
  });

  it('④ R2：真超付时报出来，且是链级累计口径', async () => {
    const { project, root, sub } = await makeChain('ANOM-4', { ratio: 0.8 });
    await settlementRow({ projectId: project.id, contractId: root.id, amount: 1000, settleDate: new Date(2026, 5, 10) });
    await paymentRow({ projectId: project.id, contractId: root.id, amount: 500, payDate: new Date(2026, 5, 11) });
    await paymentRow({ projectId: project.id, contractId: sub.id, amount: 400, payDate: new Date(2026, 5, 12) });
    // 累计已付 900 > 上限 800

    const res = await svc.payment(period as any, project.id, INT_USER);
    const hit = res.findings.find((f) => f.code === 'R2_OVERPAY');
    assert.ok(hit, `应报超付，实际命中：${res.findings.map((f) => f.code).join(',')}`);
    const facts = hit!.facts as any;
    assert.equal(facts.累计结算金额, '1000.00', '分母是链上累计结算额');
    assert.equal(facts.累计已付, '900.00', '分子是链上累计付款（含补充协议）');
    assert.ok(String(facts.口径).includes('整链'), '事实要写清是整链口径，避免用户拿单合同核对');
  });

  it('⑤ 区间上界取当日末刻：库里 14:30 的付款不会被漏掉', async () => {
    const { project, root } = await makeChain('ANOM-5', { ratio: 0.8 });
    await settlementRow({ projectId: project.id, contractId: root.id, amount: 1000, settleDate: new Date(2026, 5, 1) });
    await paymentRow({ projectId: project.id, contractId: root.id, amount: 900, payDate: AT_1430 });

    // to 就取付款那一天：未收到末刻时 14:30 的付款会被 `payDate <= to` 排除 → 超付漏报
    const res = await svc.payment({ from: '2026-06-01', to: '2026-06-15', narrative: '0' } as any, project.id, INT_USER);
    assert.ok(
      res.findings.some((f) => f.code === 'R2_OVERPAY'),
      `当天 14:30 的付款必须计入（900 > 800），实际命中：${res.findings.map((f) => f.code).join(',')}`,
    );
  });
});
