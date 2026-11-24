// @domains: settlement, contract
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  bootIntApp,
  makeContract,
  makeProject,
  readQueryParamKeys,
  readWebTypeKeys,
  type IntContext,
} from './helpers';
import { SettlementService } from '../src/modules/settlement';

/**
 * 集成测试 · **结算域接口契约**（响应字段集 + 请求参数名），锁住 `web/src/api/types/settlement.ts`。
 *
 * 覆盖两条列表 + 两条参数清单（结算单 `/settlements`、结算台账 `/settlements/ledger`），
 * 做法与台账/付款两批一致（工具在 `helpers.ts`）。本域额外钉两件事：
 * 1. 金额是 Prisma `Decimal` 原样下发 → **JSON 里是 string**（这两个列表都没过 `num()`）；
 * 2. 结算台账的 `settlementId` **允许为空**（只是费用行/删单后保留的行），不是脏数据。
 */
describe('集成 · 结算域接口契约（响应字段集 / 请求参数名）', () => {
  let ctx: IntContext;
  let settlement: SettlementService;

  const TYPE_FILE = 'web/src/api/types/settlement.ts';

  before(async () => {
    ctx = await bootIntApp();
    settlement = ctx.get<SettlementService>(SettlementService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('前置：能从前端类型文件抽出契约清单（防空转）', () => {
    assert.equal(readWebTypeKeys(TYPE_FILE, 'SETTLEMENT_ROW_KEYS').length, 15);
    assert.equal(readWebTypeKeys(TYPE_FILE, 'SETTLEMENT_LIST_PARAM_KEYS').length, 6);
    assert.equal(readWebTypeKeys(TYPE_FILE, 'SETTLEMENT_LEDGER_ROW_KEYS').length, 22);
    assert.equal(readWebTypeKeys(TYPE_FILE, 'SETTLEMENT_LEDGER_LIST_PARAM_KEYS').length, 5);
  });

  const assertRowShape = (row: any, keysConst: string, optionalConst: string, label: string) => {
    const actual = Object.keys(row).sort();
    const declared = [...readWebTypeKeys(TYPE_FILE, keysConst)].sort();
    const optional = new Set(readWebTypeKeys(TYPE_FILE, optionalConst));

    const undeclared = actual.filter((k) => !declared.includes(k));
    assert.deepEqual(undeclared, [], `${label}：后端多返回了未声明的字段（同步 web/src/api/types/settlement.ts）：\n  ${undeclared.join('\n  ')}`);

    const missing = declared.filter((k) => !optional.has(k) && !actual.includes(k));
    assert.deepEqual(missing, [], `${label}：类型声明为必填但后端没返回（字段被删 或 该标 optional）：\n  ${missing.join('\n  ')}`);
  };

  it('结算单行字段集与类型声明一致（金额经 JSON 是 string）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-settlement');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });
    await ctx.prisma.settlement.create({
      data: { projectId: project.id, contractId: contract.id, code: 'INT-ST-1', typeCode: 'PROGRESS', amount: 100, actualAmount: 90, statusCode: 'SUBMITTED' } as any,
    });

    const res: any = await settlement.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1, '夹具结算单应能被取到');
    assertRowShape(res.list[0], 'SETTLEMENT_ROW_KEYS', 'SETTLEMENT_ROW_OPTIONAL_KEYS', '结算单行');

    const asJson = JSON.parse(JSON.stringify(res.list[0]));
    assert.equal(typeof asJson.amount, 'string', '结算金额经 JSON 后应是字符串（Decimal.toJSON）；改成 num() 请同步类型');
  });

  it('结算台账行字段集与类型声明一致（settlementId 允许为空）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-settle-ledger');
    const contract = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });
    // 刻意造一条「无结算单的仅费用行」：settlementId = null 是合法形态
    await ctx.prisma.settlementLedger.create({
      data: { projectId: project.id, contractId: contract.id, settleMonth: '2026-09', monthSettleAmount: 0, factoringDiscount: 12.34 } as any,
    });

    const res: any = await settlement.findLedger({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1, '夹具结算台账行应能被取到');
    assert.equal(res.list[0].settlementId, null, '仅费用行没有结算单：settlementId 为 null 是合法口径');
    assertRowShape(res.list[0], 'SETTLEMENT_LEDGER_ROW_KEYS', 'SETTLEMENT_LEDGER_ROW_OPTIONAL_KEYS', '结算台账行');
  });

  it('两套请求参数名与服务端 query.* 逐字一致', () => {
    assert.deepEqual(
      readQueryParamKeys(join(__dirname, '..', 'src', 'modules', 'settlement', 'settlement.service.ts'), 'async findAll(', 'async findOne('),
      readWebTypeKeys(TYPE_FILE, 'SETTLEMENT_LIST_PARAM_KEYS').sort(),
      '结算单查询参数名与前端声明不一致（页面 extraFilters 的 key 必须来自 SETTLEMENT_LIST_PARAM_KEYS）',
    );
    assert.deepEqual(
      readQueryParamKeys(join(__dirname, '..', 'src', 'modules', 'settlement', 'settlement-ledger.service.ts'), 'async findLedger(', 'async ledgerOne('),
      readWebTypeKeys(TYPE_FILE, 'SETTLEMENT_LEDGER_LIST_PARAM_KEYS').sort(),
      '结算台账查询参数名与前端声明不一致',
    );
  });
});
