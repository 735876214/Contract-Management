// @domains: procurement
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { ProcurementTaskService } from '../src/modules/procurement/procurement-task.service';
import {
  estimatedAmountYuan,
  estimatedAmountMap,
  PRE_MEETING_THRESHOLD_YUAN,
} from '../src/modules/procurement/procurement-task-shared';

/**
 * 集成测试 · **采购阶段表单**（真库、真 upsert、真阈值）。
 *
 * 覆盖（P1-3 拆分后，六阶段表单迁入 ProcurementStageFormsService 的回归）：
 * ① **预计金额口径统一**（P2 修复）：列表用 estimatedAmountMap、详情/采前会/合同带入用
 *    estimatedAmountYuan，两者必须**逐分一致**（同一精确十进制引擎）；旧实现列表用裸浮点会漂移；
 * ② 采购公告 / 采购文件 / 采前会会议纪要 / 框架协议事前说明 / 成交报告 的 save → get 往返
 *    （含 JSON 列、候选人快照、金额≥阈值的采前会生成条件）。
 *
 * 为什么需要 DB：纯函数单测证明不了「upsert 真的落库 + JSON 列真的解析回数组 + 阈值真的放行/拦截」，
 * 也证明不了「列表批算」与「详情单算」两条读路径对得上。这些正是本次拆分的风险点。
 */

describe('集成 · 采购阶段表单（六阶段往返 + 预计金额同口径）', () => {
  let ctx: IntContext;
  let svc: ProcurementTaskService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<ProcurementTaskService>(ProcurementTaskService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 建任务（直接落库，便于精确控制 type/stage/preMeetingRequired） */
  async function makeTask(tag: string, opts: { type?: string; stage?: number; preMeetingRequired?: boolean } = {}) {
    const project = await makeProject(ctx.prisma, tag);
    const task = await ctx.prisma.procurementTask.create({
      data: {
        projectId: project.id,
        taskNo: uniq('INT-TASK').toUpperCase(),
        type: opts.type ?? 'SINGLE',
        content: '集成测试用采购任务',
        status: 'NOT_STARTED',
        stage: opts.stage ?? 0,
        preMeetingRequired: opts.preMeetingRequired ?? false,
      } as any,
    });
    return { project, task };
  }

  /** 造物资基础 + 一条总采购清单行（金额 = planPrice × qty），返回该行金额 */
  async function addTotalItem(task: { id: string; projectId: string }, planPrice: number, qty: number) {
    const base = await ctx.prisma.materialBase.create({
      data: { name: `集成物资-${uniq('mb')}`, spec: '规格', unit: '件' },
    });
    await ctx.prisma.procurementTotalItem.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        materialBaseId: base.id,
        materialName: base.name,
        spec: base.spec,
        unit: '件',
        qty,
        planPrice,
        sortOrder: 0,
      },
    });
    return planPrice * qty;
  }

  it('预计采购金额：列表批算与详情单算同口径（P2 回归，逐分一致）', async () => {
    const { task } = await makeTask('p2');
    // 3 × 333.335：逐行精确乘法后 2 位舍入 = 1000.01（裸浮点得 1000.004999…，两行累计即出现分位漂移）
    await addTotalItem(task, 333.335, 3);
    await addTotalItem(task, 333.335, 3);

    const yuan = await estimatedAmountYuan(ctx.prisma, task.id);
    const mapVal = (await estimatedAmountMap(ctx.prisma, [task.id])).get(task.id)!;
    assert.equal(yuan, 2000.02, '详情口径＝逐行精确乘法后 2 位舍入再累加');
    assert.equal(mapVal, yuan, '列表口径必须与详情口径逐分一致（旧实现用裸浮点会漂移）');
  });

  it('采购公告：save → get 往返（清单只读来自总采购清单）', async () => {
    const { task } = await makeTask('notice', { stage: 6 });
    await addTotalItem(task, 10, 1);
    const saved = await svc.saveNotice(task.id, {
      procurementNo: 'GG-001',
      content: '公告正文',
      contacts: ['张三', '李四'],
      contactPhones: ['13800000000'],
    });
    assert.equal(saved.procurementNo, 'GG-001');

    const got = await svc.notice(task.id);
    assert.equal(got.data?.procurementNo, 'GG-001');
    assert.deepEqual(got.data?.contacts, ['张三', '李四']);
    assert.equal(got.purchaseItems.length, 1, '公告清单来自总采购清单');
  });

  it('采购文件：save → get 往返', async () => {
    const { task } = await makeTask('doc', { stage: 6 });
    const saved = await svc.saveDocument(task.id, { responseDeposit: 5000, quoteDescription: '报价说明' });
    assert.equal(saved.responseDeposit, 5000);

    const got = await svc.document(task.id);
    assert.equal(got.data?.responseDeposit, 5000);
    assert.equal(got.data?.quoteDescription, '报价说明');
  });

  it('采前会会议纪要：达阈值时 save → get 往返', async () => {
    const { task } = await makeTask('pre', { stage: 6 });
    await addTotalItem(task, PRE_MEETING_THRESHOLD_YUAN, 1); // 恰好达阈值 → 允许编制
    const saved = await svc.savePreMeetingMinutes(task.id, {
      host: '主持人A',
      attendees: '甲/乙',
      content: '纪要正文',
    });
    assert.equal(saved.host, '主持人A');

    const got = await svc.preMeetingMinutes(task.id);
    assert.equal(got.data?.host, '主持人A');
    assert.equal(got.data?.attendees, '甲/乙');
  });

  it('框架协议事前说明：save → get 往返（FRAMEWORK 任务，JSON 行解析回数组）', async () => {
    const { task } = await makeTask('fw', { type: 'FRAMEWORK', stage: 2 });
    const saved = await svc.saveFrameworkExplanation(task.id, {
      frameworkIntro: '框架简介',
      negotiation: '谈判情况',
      inquiryRows: [{ rank: 1, unit: '供应商A', totalPrice: 100 }],
    });
    assert.equal(saved.frameworkIntro, '框架简介');
    assert.equal(saved.inquiryRows.length, 1);

    const got = await svc.frameworkExplanation(task.id);
    assert.equal(got.data?.frameworkIntro, '框架简介');
    assert.equal(got.data?.inquiryRows?.length, 1);
  });

  it('成交报告：save → get 往返（含拟推荐成交候选人快照）', async () => {
    const { task } = await makeTask('result', { stage: 6 });
    const saved = await svc.saveResultReport(task.id, {
      unitCount: 1,
      openPlace: '开标室',
      candidates: [{ name: '候选单位A', finalPreTaxPrice: 100000 }],
    });
    assert.equal(saved.unitCount, 1);
    assert.equal(saved.candidates.length, 1);

    const got = await svc.resultReport(task.id);
    assert.equal(got.data?.openPlace, '开标室');
    assert.equal(got.data?.candidates?.[0]?.name, '候选单位A');
  });
});
