// @domains: procurement
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  bootIntApp,
  makeProject,
  makeTask,
  readQueryParamKeys,
  readWebTypeKeys,
  type IntContext,
} from './helpers';
import { ProcurementTaskService } from '../src/modules/procurement';

/**
 * 集成测试 · **采购任务域接口契约**（响应字段集 + 请求参数名），锁住 `web/src/api/types/procurement.ts`。
 *
 * 采购任务是最复杂的工作流域：一个任务有六张阶段子单据 + 投标/评标/价格对比，
 * `findAll` 还按 `module` 参数**联表带出不同形状**的 `module` 字段。字段漂移会让列表/详情
 * 读到 `undefined` 而不报错（页面静默空白），所以这里把最容易漂移的三处逐字锁住：
 *  1. 任务行（`serializeTask` 派生的 22 键，含 `statusLabel` / 派生 `contractId`）；
 *  2. 总采购清单行（`serializeItem` 的 12 键，金额过 `num()` → number）；
 *  3. `findAll()` 实际读取的 `query.*` 键（**不是**页面筛选项的 label）。
 */
describe('集成 · 采购任务域接口契约（响应字段集 / 请求参数名）', () => {
  let ctx: IntContext;
  let procurement: ProcurementTaskService;
  const TYPE_FILE = 'web/src/api/types/procurement.ts';

  before(async () => {
    ctx = await bootIntApp();
    procurement = ctx.get<ProcurementTaskService>(ProcurementTaskService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('前置：能从前端类型文件抽出契约清单（防空转）', () => {
    assert.equal(readWebTypeKeys(TYPE_FILE, 'PROCUREMENT_TASK_ROW_KEYS').length, 22);
    assert.equal(readWebTypeKeys(TYPE_FILE, 'PROCUREMENT_TOTAL_ITEM_KEYS').length, 12);
    assert.ok(readWebTypeKeys(TYPE_FILE, 'PROCUREMENT_TASK_LIST_PARAM_KEYS').length >= 20);
  });

  it('采购任务行字段集与类型声明一致（列表）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-procurement');
    await makeTask(ctx.prisma, { projectId: project.id, type: 'SINGLE', stage: 0 });

    const res: any = await procurement.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1, '夹具采购任务应能被取到');

    const actual = Object.keys(res.list[0]).sort();
    // 列表行在任务行基础上额外带 estimatedAmountWan + module（本用例未传 module，module 为 null）
    const declared = [...readWebTypeKeys(TYPE_FILE, 'PROCUREMENT_TASK_ROW_KEYS'), 'estimatedAmountWan', 'module'].sort();

    const undeclared = actual.filter((k) => !declared.includes(k));
    assert.deepEqual(undeclared, [], `采购任务列表行：后端多返回了未声明的字段（同步 web/src/api/types/procurement.ts）：\n  ${undeclared.join('\n  ')}`);

    const missing = declared.filter((k) => !actual.includes(k));
    assert.deepEqual(missing, [], `采购任务列表行：类型声明为必填但后端没返回：\n  ${missing.join('\n  ')}`);

    assert.equal(typeof res.list[0].estimatedAmountWan, 'number', '预计采购金额（万元）应是 number');
  });

  it('采购任务详情字段集与类型声明一致（findOne：任务行 + estimatedAmountWan + stages）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-procurement-detail');
    const task = await makeTask(ctx.prisma, { projectId: project.id, type: 'SINGLE', stage: 0 });

    const detail: any = await procurement.findOne(task.id);
    const actual = Object.keys(detail).sort();
    const declared = [
      ...readWebTypeKeys(TYPE_FILE, 'PROCUREMENT_TASK_ROW_KEYS'),
      'estimatedAmountWan',
      'stages',
    ].sort();

    const undeclared = actual.filter((k) => !declared.includes(k));
    assert.deepEqual(undeclared, [], `采购任务详情：后端多返回了未声明的字段：\n  ${undeclared.join('\n  ')}`);
    assert.ok(Array.isArray(detail.stages) && detail.stages.length > 0, 'stages 应是非空阶段视图数组');
    assert.ok('key' in detail.stages[0] && 'label' in detail.stages[0] && 'state' in detail.stages[0], '阶段格应含 key/label/state');
  });

  it('总采购清单行字段集与类型声明一致（空清单也要能取，items 为空数组）', async () => {
    const project = await makeProject(ctx.prisma, 'shape-procurement-total');
    const task = await makeTask(ctx.prisma, { projectId: project.id, type: 'SINGLE', stage: 0 });

    const total: any = await procurement.totalList(task.id);
    assert.equal(total.frozen, false, 'stage=0 时未冻结');
    assert.ok(Array.isArray(total.items), 'items 应为数组');
    // 无明细时用一条手工行验证键集（list 为空不构成「键集」证据）
    await ctx.prisma.procurementTotalItem.create({
      data: {
        projectId: project.id,
        taskId: task.id,
        materialBaseId: 'mb-x',
        materialName: '测试物资',
        spec: '规格',
        unit: '吨',
        sortOrder: 0,
      } as any,
    });
    const withItem: any = await procurement.totalList(task.id);
    assert.equal(withItem.items.length, 1);
    const actual = Object.keys(withItem.items[0]).sort();
    const declared = [...readWebTypeKeys(TYPE_FILE, 'PROCUREMENT_TOTAL_ITEM_KEYS')].sort();
    const undeclared = actual.filter((k) => !declared.includes(k));
    assert.deepEqual(undeclared, [], `总采购清单行：后端多返回了未声明的字段：\n  ${undeclared.join('\n  ')}`);
    assert.equal(typeof withItem.items[0].sortOrder, 'number');
  });

  it('请求参数名与 findAll() 实际读取的 query.* 逐字一致', () => {
    assert.deepEqual(
      readQueryParamKeys(
        join(__dirname, '..', 'src', 'modules', 'procurement', 'procurement-task.service.ts'),
        'async findAll(',
        'async findOne(',
      ),
      [...readWebTypeKeys(TYPE_FILE, 'PROCUREMENT_TASK_LIST_PARAM_KEYS')].sort(),
      '采购任务查询参数名与前端声明不一致（注意 page/pageSize 由 paginate() 消费）',
    );
  });
});
