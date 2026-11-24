// @domains: contract
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
import { ContractService } from '../src/modules/contract';

/**
 * 集成测试 · **合同域接口契约**（响应字段集 + 请求参数名），锁住 `web/src/api/types/contract.ts`。
 *
 * 合同是本系统字段最多的实体（列表行 **50 键**：44 个标量 + id/createdAt/version/updatedAt
 * + `supplier` + `ext`），也是被台账/结算/付款/发票跨域引用的主体，字段漂移代价最高。
 *
 * 另外这里钉住两处**易混口径**：
 * 1. 合同查询参数是 `code / name / execStatus / startDate / endDate`，**不是**台账那套
 *    `contractCode / typeCode / supplierCategory`（两套名字各有各的 spec 锁）；
 * 2. `status`（起草流转）与 `execStatus`（执行情况）是两个字段，都存在且都返回。
 */
describe('集成 · 合同域接口契约（响应字段集 / 请求参数名）', () => {
  let ctx: IntContext;
  let contract: ContractService;
  const TYPE_FILE = 'web/src/api/types/contract.ts';

  before(async () => {
    ctx = await bootIntApp();
    contract = ctx.get<ContractService>(ContractService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('前置：能从前端类型文件抽出契约清单（防空转）', () => {
    assert.equal(readWebTypeKeys(TYPE_FILE, 'CONTRACT_ROW_KEYS').length, 50);
    assert.equal(readWebTypeKeys(TYPE_FILE, 'CONTRACT_ROW_OPTIONAL_KEYS').length, 0);
    assert.equal(readWebTypeKeys(TYPE_FILE, 'CONTRACT_LIST_PARAM_KEYS').length, 10);
  });

  it('合同行字段集与类型声明一致（金额经 JSON 是 string）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-contract');
    const supplier = await makeSupplier(ctx.prisma, project.id);
    await makeContract(ctx.prisma, { projectId: project.id, supplierId: supplier.id, amount: 1000 });

    const res: any = await contract.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1, '夹具合同应能被取到');

    const actual = Object.keys(res.list[0]).sort();
    const declared = [...readWebTypeKeys(TYPE_FILE, 'CONTRACT_ROW_KEYS')].sort();
    const optional = new Set(readWebTypeKeys(TYPE_FILE, 'CONTRACT_ROW_OPTIONAL_KEYS'));

    const undeclared = actual.filter((k) => !declared.includes(k));
    assert.deepEqual(undeclared, [], `合同行：后端多返回了未声明的字段（同步 web/src/api/types/contract.ts）：\n  ${undeclared.join('\n  ')}`);

    const missing = declared.filter((k) => !optional.has(k) && !actual.includes(k));
    assert.deepEqual(missing, [], `合同行：类型声明为必填但后端没返回：\n  ${missing.join('\n  ')}`);

    const asJson = JSON.parse(JSON.stringify(res.list[0]));
    assert.equal(typeof asJson.amount, 'string', '合同金额经 JSON 后应是字符串（Decimal.toJSON）；改成 num() 请同步类型');
    assert.ok('status' in asJson && 'execStatus' in asJson, 'status（起草流转）与 execStatus（执行情况）是**两个**字段，两个都要在');
  });

  it('请求参数名与 findAll() 实际读取的 query.* 逐字一致', () => {
    assert.deepEqual(
      readQueryParamKeys(join(__dirname, '..', 'src', 'modules', 'contract', 'contract.service.ts'), 'async findAll(', 'async findOne('),
      [...readWebTypeKeys(TYPE_FILE, 'CONTRACT_LIST_PARAM_KEYS')].sort(),
      '合同查询参数名与前端声明不一致（注意与台账的 contractCode/typeCode 是两套名字）',
    );
  });
});
