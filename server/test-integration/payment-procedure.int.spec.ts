// @domains: payment-procedure, settlement, payment
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeContract, makeProject, makeSupplier, type IntContext } from './helpers';
import { PaymentProcedureService } from '../src/modules/payment-procedure';
import { PaymentService } from '../src/modules/payment';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { PAYMENT_STATUS, SETTLEMENT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · **付款手续的「开累」快照**（业务口径 2026-10-16）。
 *
 * 纯函数层（`deriveProcedureAmounts` 的舍入与负值语义）已由 `test/smallModules.spec.mts` 锁住，
 * 这里补的是**只有真库才能证明**的三件事：
 * ① 新建时四个数字确实是**服务端按合同链口径**算出并落库的（前端传什么都不采信，供应商也由合同带出）；
 * ② **快照语义**：单据是留痕，事后补录付款**不改写**已出的单据；
 * ③ 换合同才重取（否则单据上的「开累」还是旧合同的）。
 * 另附编号规则（`FK-<合同号>-<YYYYMMDD>`，同日重复追加 `-2`）的回归。
 */
describe('集成 · 付款手续的开累快照', () => {
  let ctx: IntContext;
  let procedures: PaymentProcedureService;
  let payments: PaymentService;
  let settlements: SettlementService;

  before(async () => {
    ctx = await bootIntApp();
    procedures = ctx.get<PaymentProcedureService>(PaymentProcedureService);
    payments = ctx.get<PaymentService>(PaymentService);
    settlements = ctx.get<SettlementService>(SettlementService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 造一份「合同 + 供应商」，可选带结算/付款各一笔 */
  async function fixture(tag: string, opts: { settled?: number; paid?: number; amount?: number } = {}) {
    const project = await makeProject(ctx.prisma, tag);
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, {
      projectId: project.id,
      supplierId: supplier.id,
      amount: opts.amount ?? 100000,
    });
    if (opts.settled) {
      await settlements.create(
        {
          contractId: contract.id,
          typeCode: 'PROGRESS',
          statusCode: SETTLEMENT_STATUS.CONFIRMED,
          amount: opts.settled,
          settleDate: new Date(2026, 2, 15),
        },
        project.id,
      );
    }
    if (opts.paid) {
      await payments.createRecord(
        {
          contractId: contract.id,
          amount: opts.paid,
          statusCode: PAYMENT_STATUS.PAID,
          methodCode: 'TRANSFER',
          payDate: new Date(2026, 2, 20),
        },
        project.id,
      );
    }
    return { project, supplier, contract };
  }

  it('① 新建：开累结算/付款/未付款按合同链口径落库，供应商由合同带出（前端传的被忽略）', async () => {
    const { project, supplier, contract } = await fixture('PP-1', { settled: 30000, paid: 10000 });

    const row: any = await procedures.create(
      {
        contractId: contract.id,
        statusCode: PAYMENT_STATUS.PENDING,
        payDate: new Date(2026, 3, 1),
        // 前端**故意**传一个别的供应商：必须被服务端按合同覆盖
        supplierId: 'front-end-supplier-must-be-ignored',
        settleCumAmount: 999999,
        paidCumAmount: 999999,
        unpaidAmount: 999999,
      },
      project.id,
    );

    assert.equal(row.supplierId, supplier.id, '供应商必须由合同带出，不接受前端直传');
    assert.equal(Number(row.settleCumAmount), 30000, '开累结算 = 合同链已确认结算额');
    assert.equal(Number(row.paidCumAmount), 10000, '开累付款 = 合同链有效付款（排除失败/退款）');
    assert.equal(Number(row.unpaidAmount), 20000, '未付款 = 开累结算 − 开累付款');

    // 落库值不是前端传的 999999
    const fresh = await ctx.prisma.paymentProcedure.findUnique({ where: { id: row.id } });
    assert.equal(Number(fresh!.settleCumAmount), 30000);
  });

  it('② 快照语义：不换合同时，事后补录付款不会改写已出单据的数字', async () => {
    const { project, contract } = await fixture('PP-2', { settled: 50000, paid: 10000 });
    const row: any = await procedures.create(
      { contractId: contract.id, statusCode: PAYMENT_STATUS.PENDING, payDate: new Date(2026, 3, 2) },
      project.id,
    );
    assert.equal(Number(row.unpaidAmount), 40000);

    // 事后又付了 2 万（台账口径会变，但这张单据是留痕、不该变）
    await payments.createRecord(
      { contractId: contract.id, amount: 20000, statusCode: PAYMENT_STATUS.PAID, methodCode: 'TRANSFER', payDate: new Date(2026, 3, 3) },
      project.id,
    );
    // 只改备注（不换合同）
    await procedures.update(row.id, { remark: '补录后仅改备注', version: row.version });

    const after: any = await procedures.findOne(row.id);
    assert.equal(Number(after.paidCumAmount), 10000, '不换合同 → 开累付款保持编制当时的快照');
    assert.equal(Number(after.unpaidAmount), 40000);
    assert.equal(after.remark, '补录后仅改备注');
  });

  it('③ 换合同：四个数字按新合同重取（否则单据上的「开累」还是旧合同的）', async () => {
    const a = await fixture('PP-3A', { settled: 50000, paid: 10000 });
    const b = await fixture('PP-3B', { settled: 8000, paid: 3000 });

    const row: any = await procedures.create(
      { contractId: a.contract.id, statusCode: PAYMENT_STATUS.PENDING, payDate: new Date(2026, 3, 4) },
      a.project.id,
    );
    assert.equal(Number(row.unpaidAmount), 40000);

    const moved: any = await procedures.update(row.id, { contractId: b.contract.id, version: row.version });
    assert.equal(Number(moved.settleCumAmount), 8000, '换合同后开累结算按新合同重取');
    assert.equal(Number(moved.paidCumAmount), 3000);
    assert.equal(Number(moved.unpaidAmount), 5000);
    assert.equal(moved.supplierId, b.supplier.id, '供应商也跟着换成新合同的');
  });

  it('④ 编号：FK-<合同号>-<YYYYMMDD>，同日第二张自动追加 -2', async () => {
    const { project, contract } = await fixture('PP-4');
    const payDate = new Date(2026, 4, 6);

    const first: any = await procedures.create(
      { contractId: contract.id, statusCode: PAYMENT_STATUS.PENDING, payDate },
      project.id,
    );
    const second: any = await procedures.create(
      { contractId: contract.id, statusCode: PAYMENT_STATUS.PENDING, payDate },
      project.id,
    );

    assert.match(first.code, /^FK-.+-20260506$/, `首张编号形如 FK-<合同号>-20260506，实际 ${first.code}`);
    assert.equal(second.code, `${first.code}-2`, '同日第二张应在首张后追加 -2');
  });

  it('⑤ 付款超过结算时「未付款」为负数（该被看见的异常，不抹平）', async () => {
    const { project, contract } = await fixture('PP-5', { settled: 10000, paid: 20000 });
    const row: any = await procedures.create(
      { contractId: contract.id, statusCode: PAYMENT_STATUS.PENDING, payDate: new Date(2026, 5, 1) },
      project.id,
    );
    assert.equal(Number(row.unpaidAmount), -10000, '开累付款 > 开累结算 → 未付款为负，不兜成 0');
  });
});
