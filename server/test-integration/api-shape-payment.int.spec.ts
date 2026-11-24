// @domains: payment, payment-procedure, contract
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  bootIntApp,
  makeContract,
  makeProject,
  makeSupplier,
  readQueryParamKeys,
  readWebTypeKeys,
  type IntContext,
} from './helpers';
import { PaymentService } from '../src/modules/payment';
import { PaymentProcedureService } from '../src/modules/payment-procedure';

/**
 * 集成测试 · **付款域接口契约**（响应字段集 + 请求参数名），锁住 `web/src/api/types/payment.ts`。
 *
 * 与 `api-shape-ledger.int.spec.ts` 同一套做法（工具在 `helpers.ts` 的
 * `readWebTypeKeys` / `readQueryParamKeys`）：后端加/删字段、前端凭空造字段、
 * 请求参数名写错（台账那次真出过），任一都会在这里红。
 *
 * 付款域还有两个**类型陷阱**被这里顺手钉住：
 * 1. `amount` / `settleCumAmount` 等是 Prisma `Decimal` **原样下发 → string**（与台账过 `num()` 不同）；
 * 2. `GET /payments/records` **不支持 `keyword`**（服务端只按合同/月份/状态过滤）。
 */
describe('集成 · 付款域接口契约（响应字段集 / 请求参数名）', () => {
  let ctx: IntContext;
  let payment: PaymentService;
  let procedure: PaymentProcedureService;

  before(async () => {
    ctx = await bootIntApp();
    payment = ctx.get<PaymentService>(PaymentService);
    procedure = ctx.get<PaymentProcedureService>(PaymentProcedureService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('前置：能从前端类型文件抽出契约清单（防空转）', () => {
    assert.equal(readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_RECORD_ROW_KEYS').length, 14);
    assert.equal(readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_RECORD_LIST_PARAM_KEYS').length, 5);
    assert.equal(readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_PROCEDURE_ROW_KEYS').length, 17);
    assert.equal(readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_PROCEDURE_LIST_PARAM_KEYS').length, 8);
  });

  /** 响应键集双向断言：多一个未声明 / 少一个必填 都红 */
  const assertRowShape = (row: any, typeKeys: string[], optionalKeys: string[], label: string) => {
    const actual = Object.keys(row).sort();
    const declared = [...typeKeys].sort();
    const optional = new Set(optionalKeys);

    const undeclared = actual.filter((k) => !declared.includes(k));
    assert.deepEqual(undeclared, [], `${label}：后端多返回了未声明的字段（同步 web/src/api/types/payment.ts）：\n  ${undeclared.join('\n  ')}`);

    const missing = declared.filter((k) => !optional.has(k) && !actual.includes(k));
    assert.deepEqual(missing, [], `${label}：类型声明为必填但后端没返回（字段被删 或 该标 optional）：\n  ${missing.join('\n  ')}`);
  };

  it('付款记录行字段集与类型声明一致', async () => {
    const project = await makeProject(ctx.prisma, 'shape-payment');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000 });
    await ctx.prisma.paymentRecord.create({
      data: { projectId: project.id, contractId: contract.id, payMonth: '2026-09', amount: 100, methodCode: 'TRANSFER', statusCode: 'PAID' } as any,
    });

    const res: any = await payment.findRecords({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1, '夹具付款记录应能被取到');
    assertRowShape(
      res.list[0],
      readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_RECORD_ROW_KEYS'),
      readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_RECORD_OPTIONAL_KEYS'),
      '付款记录行',
    );
    // 金额是 Prisma Decimal 原样下发：钉住"**过一遍 JSON 之后是 string**"这条
    // （service 返回值里它是 Decimal 对象，前端拿到的是它 toJSON 后的字符串）。
    // 哪天改成 num() 给了 number，这里会红，提示同步 web 侧类型。
    const asJson = JSON.parse(JSON.stringify(res.list[0]));
    assert.equal(typeof asJson.amount, 'string', '付款记录 amount 经 JSON 后应是字符串（Decimal.toJSON）；改成 num() 请同步类型');
  });

  it('付款手续行字段集与类型声明一致', async () => {
    const project = await makeProject(ctx.prisma, 'shape-procedure');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    const contract = await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000 });
    await ctx.prisma.paymentProcedure.create({
      data: { projectId: project.id, contractId: contract.id, supplierId: supplier.id, payDate: new Date('2026-09-15') } as any,
    });

    const res: any = await procedure.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1, '夹具付款手续应能被取到');
    assertRowShape(
      res.list[0],
      readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_PROCEDURE_ROW_KEYS'),
      readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_PROCEDURE_OPTIONAL_KEYS'),
      '付款手续行',
    );
  });

  it('请求参数名与 findRecords() / findAll() 实际读取的 query.* 逐字一致', () => {
    assert.deepEqual(
      readQueryParamKeys(join(__dirname, '..', 'src', 'modules', 'payment', 'payment.service.ts'), 'async findRecords(', 'async createRecord('),
      readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_RECORD_LIST_PARAM_KEYS').sort(),
      '付款记录查询参数名与前端声明不一致（页面 extraFilters 的 key 必须来自 PAYMENT_RECORD_LIST_PARAM_KEYS）',
    );
    assert.deepEqual(
      readQueryParamKeys(join(__dirname, '..', 'src', 'modules', 'payment-procedure', 'payment-procedure.service.ts'), 'async findAll(', 'async findOne('),
      readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_PROCEDURE_LIST_PARAM_KEYS').sort(),
      '付款手续查询参数名与前端声明不一致',
    );
  });
});
