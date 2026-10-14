import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as ExcelJS from 'exceljs';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import {
  ProcurementTaskService,
  priceCompareStageIndex,
} from '../src/modules/procurement/procurement-task.service';
import { BIDDER_STATUS, CONTRACT_STATUS } from '../src/constants/statuses';

/**
 * 集成测试 · **招标域结构化：投标/响应单位 + 评标记录**（真库、真导入、真发布）。
 *
 * 覆盖（对应「下一期：招标域结构化」的验收口径）：
 * ① 导入「响应单位情况汇总表」→ JSON 快照与结构化行**双写**，重复导入幂等；
 * ② 重新导入**不得静默删除**有评标记录的单位（报错并保持数据完好）；
 * ③ 勾选「拟推荐成交候选人」= 定标 → 结构化行置 `WON` + 写入最终确认价；取消勾选**回落**入围/已递交；
 * ④ 评标记录全量替换 + 三条校验（评委必填 / 结论走字典 / 单位必须属于本任务）；
 * ⑤ **定标行 → 生成合同**：走真实 `publish()` 路径生成多份合同，单位与金额取自结构化行。
 *
 * 为什么这条链路需要 DB 集成测试：纯函数单测只能证明 `candidatesFromBidders()` 的映射对，
 * 证明不了「导入真的双写了」「勾选真的改了状态」「生成合同时读的是结构化行而不是旧 JSON」。
 */

const BIDDER_HEADERS = [
  '序号',
  '参与响应单位名称',
  '响应保证金是否缴纳',
  '响应文件密封是否完整',
  '是否通过第一轮报价',
  '第一轮报价不含税总额',
  '第一轮报价税金',
  '第二轮报价不含税总额',
  '第二轮报价税金',
  '备注',
];

/** 造一份「响应单位情况汇总表」（表头在第 1 行，与 ExcelService.parse 的口径一致） */
async function bidderXlsx(rows: Array<Record<string, any>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('响应单位');
  ws.addRow(BIDDER_HEADERS);
  for (const r of rows) ws.addRow(BIDDER_HEADERS.map((h) => r[h] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const supplier = (name: string, first: number, second: number | null, passedFirst = '是') => ({
  序号: null,
  参与响应单位名称: name,
  响应保证金是否缴纳: '是',
  响应文件密封是否完整: '是',
  是否通过第一轮报价: passedFirst,
  第一轮报价不含税总额: first,
  第一轮报价税金: Math.round(first * 0.13),
  第二轮报价不含税总额: second,
  第二轮报价税金: second == null ? null : Math.round(second * 0.13),
  备注: null,
});

describe('集成 · 招标域结构化（投标单位 / 评标 / 定标 → 合同）', () => {
  let ctx: IntContext;
  let taskService: ProcurementTaskService;

  before(async () => {
    ctx = await bootIntApp();
    taskService = ctx.get<ProcurementTaskService>(ProcurementTaskService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 建一个「单项采购 + 各阶段已发布完（停在价格对比表）」的任务，便于直接走发布/生成合同 */
  async function makeReadyTask(tag: string) {
    const project = await makeProject(ctx.prisma, tag);
    // 合同编号含「项目字母简称」段，缺了会生成不出合同（nextCode 会报缺段）；
    // 该列有唯一约束，且不能按时间戳截取（同一秒内多个用例会撞），故取随机后缀
    const codeAbbr = `AB${Math.random().toString(36).slice(2, 8)}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
    await ctx.prisma.project.update({ where: { id: project.id }, data: { codeAbbr } });
    const task = await ctx.prisma.procurementTask.create({
      data: {
        projectId: project.id,
        taskNo: uniq(`INT-${tag}`).toUpperCase(),
        type: 'SINGLE',
        content: '集成测试用采购任务（招标域）',
        status: 'PRICE_COMPARE_EDITING',
        stage: 0,
        procurementCategory: '物资',
      } as any,
    });
    const stage = priceCompareStageIndex(task as any);
    await ctx.prisma.procurementTask.update({ where: { id: task.id }, data: { stage } });
    return { project, task: { ...task, stage }, stage };
  }

  it('① 导入响应单位 → JSON 快照与结构化行双写；重复导入幂等', async () => {
    const { task } = await makeReadyTask('BID-WRITE');
    const a = `甲建材-${uniq('a')}`;
    const b = `乙建材-${uniq('b')}`;
    const c = `丙建材-${uniq('c')}`;
    const rows = [supplier(a, 985000, 960000), supplier(b, 1020000, 990000), supplier(c, 1100000, null, '否')];

    const res: any = await taskService.importResultReport(task.id, await bidderXlsx(rows));
    assert.equal(res.imported, 3);

    // JSON 快照仍在（发布文档口径不变）
    const report = await ctx.prisma.procurementResultReport.findUnique({ where: { taskId: task.id } });
    assert.equal(JSON.parse(String(report?.suppliers)).length, 3, 'JSON 快照应保留');

    // 结构化行已建立，且字段来自导入表
    const bidders = await ctx.prisma.procurementBidder.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });
    assert.equal(bidders.length, 3, '结构化行应与导入行一一对应');
    assert.deepEqual(
      bidders.map((x) => x.bidderName),
      [a, b, c],
    );
    assert.equal(Number(bidders[0].firstPreTaxTotal), 985000);
    assert.equal(Number(bidders[0].secondPreTaxTotal), 960000);
    assert.equal(bidders[2].passedFirst, '否');
    assert.equal(bidders[0].status, BIDDER_STATUS.SUBMITTED, '导入后的默认状态为「已递交」');

    // 重复导入同一份文件：不新增、不重复
    await taskService.importResultReport(task.id, await bidderXlsx(rows));
    assert.equal(await ctx.prisma.procurementBidder.count({ where: { taskId: task.id } }), 3, '重复导入应幂等');
  });

  it('② 重新导入时，有评标记录的单位不得被静默删除', async () => {
    const { task } = await makeReadyTask('BID-GUARD');
    const keep = `保留单位-${uniq('k')}`;
    const drop = `将被移除-${uniq('d')}`;
    await taskService.importResultReport(task.id, await bidderXlsx([supplier(keep, 100, 90), supplier(drop, 200, 180)]));

    const all = await ctx.prisma.procurementBidder.findMany({ where: { taskId: task.id } });
    const dropRow = all.find((x) => x.bidderName === drop)!;
    await taskService.saveEvaluations(task.id, {
      evaluations: [{ bidderId: dropRow.id, evaluator: '评委甲', score: 88, conclusion: 'RECOMMEND' }],
    });

    // 只导入「保留单位」→ 该文件里已没有「将被移除」，但它有评标记录
    const onlyKeep = await bidderXlsx([supplier(keep, 100, 90)]);
    await assert.rejects(
      () => taskService.importResultReport(task.id, onlyKeep),
      (e: any) => e instanceof BadRequestException && e.message.includes(drop),
      '应报错并点名该单位，而不是静默删除',
    );
    const after = await ctx.prisma.procurementBidder.findMany({ where: { taskId: task.id } });
    assert.equal(after.length, 2, '报错后数据应保持不变');
    assert.equal(await ctx.prisma.procurementEvaluation.count({ where: { taskId: task.id } }), 1, '评标记录不应丢失');

    // 把该单位从评标记录里移除后，再导入即可正常删除
    await taskService.saveEvaluations(task.id, { evaluations: [] });
    await taskService.importResultReport(task.id, await bidderXlsx([supplier(keep, 100, 90)]));
    assert.equal(await ctx.prisma.procurementBidder.count({ where: { taskId: task.id } }), 1);
  });

  it('③ 勾选候选人 = 定标（WON + 最终确认价）；取消勾选回落入围/已递交', async () => {
    const { task } = await makeReadyTask('BID-WON');
    const a = `中标甲-${uniq('a')}`;
    const b = `中标乙-${uniq('b')}`;
    const c = `未过第一轮-${uniq('c')}`;
    const suppliers = [
      { name: a, seq: 1, passedFirst: '是', firstPreTaxTotal: 1000, secondPreTaxTotal: 900 },
      { name: b, seq: 2, passedFirst: '是', firstPreTaxTotal: 1100, secondPreTaxTotal: 950 },
      { name: c, seq: 3, passedFirst: '否', firstPreTaxTotal: 1200, secondPreTaxTotal: null },
    ];

    await taskService.saveResultReport(task.id, {
      suppliers,
      candidates: [
        { supplierIndex: 0, name: a, finalPreTaxPrice: 880 },
        { supplierIndex: 1, name: b, finalPreTaxPrice: 930 },
      ],
    });

    let rows = await ctx.prisma.procurementBidder.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });
    assert.equal(rows.length, 3, '保存成交报告时应对存量/结构化行做幂等补齐');
    const [ra, rb, rc] = rows;
    assert.equal(ra.status, BIDDER_STATUS.WON);
    assert.equal(Number(ra.finalPreTaxTotal), 880, '应写入用户填的最终确认价');
    assert.equal(rb.status, BIDDER_STATUS.WON);
    assert.equal(rc.status, BIDDER_STATUS.SUBMITTED, '未勾选的单位不应是中标态');

    // 取消勾选「乙」→ 回落（通过第一轮 → 入围），并清掉确认价
    await taskService.saveResultReport(task.id, {
      candidates: [{ supplierIndex: 0, name: a, finalPreTaxPrice: 950 }],
    });
    rows = await ctx.prisma.procurementBidder.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });
    const rb2 = rows.find((x) => x.bidderName === b)!;
    assert.equal(rb2.status, BIDDER_STATUS.SHORTLISTED, '取消中标后应回落为「入围」');
    assert.equal(rb2.finalPreTaxTotal, null, '取消中标应清掉最终确认价');
    assert.equal(Number(rows.find((x) => x.bidderName === a)!.finalPreTaxTotal), 950, '保留的中标单位应更新为新的确认价');
  });

  it('④ 评标记录：全量替换 + 评委必填 / 结论走字典 / 单位须属于本任务', async () => {
    const { task } = await makeReadyTask('BID-EVAL');
    const other = await makeReadyTask('BID-EVAL-OTHER');
    const a = `评标甲-${uniq('a')}`;
    const b = `评标乙-${uniq('b')}`;
    await taskService.importResultReport(task.id, await bidderXlsx([supplier(a, 500, 480), supplier(b, 520, 500)]));
    const otherBidder = await ctx.prisma.procurementBidder.create({
      data: { projectId: other.project.id, taskId: other.task.id, bidderName: `别任务单位-${uniq('x')}` } as any,
    });
    const rows = await ctx.prisma.procurementBidder.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });

    // 全量替换：先 2 条，再保存 1 条 → 库里只剩 1 条
    let res: any = await taskService.saveEvaluations(task.id, {
      evaluations: [
        { bidderId: rows[0].id, evaluator: '评委甲', score: 92.5, rank: 1, conclusion: 'RECOMMEND', evaluatedAt: '2026-10-19' },
        { bidderId: rows[1].id, evaluator: '评委乙', score: 80, rank: 2, conclusion: 'NOT_RECOMMEND' },
      ],
    });
    assert.equal(res.evaluations.length, 2);
    assert.equal(Number(res.evaluations[0].score), 92.5);
    res = await taskService.saveEvaluations(task.id, {
      evaluations: [{ bidderId: rows[1].id, evaluator: '评委乙', score: 85 }],
    });
    assert.equal(res.evaluations.length, 1, '评标记录为全量替换');
    assert.equal(await ctx.prisma.procurementEvaluation.count({ where: { taskId: task.id } }), 1);

    // 三条校验
    await assert.rejects(
      () => taskService.saveEvaluations(task.id, { evaluations: [{ bidderId: rows[0].id, evaluator: ' ' }] }),
      (e: any) => e instanceof BadRequestException && /评委/.test(e.message),
    );
    await assert.rejects(
      () => taskService.saveEvaluations(task.id, { evaluations: [{ bidderId: rows[0].id, evaluator: '甲', conclusion: 'WHATEVER' }] }),
      (e: any) => e instanceof BadRequestException && /字典/.test(e.message),
    );
    await assert.rejects(
      () => taskService.saveEvaluations(task.id, { evaluations: [{ bidderId: otherBidder.id, evaluator: '甲' }] }),
      (e: any) => e instanceof BadRequestException && /不属于该采购任务/.test(e.message),
    );
  });

  it('⑤ 定标 → 发布 → 按中标单位生成多份合同（单位与金额取自结构化行）', async () => {
    const { task, stage } = await makeReadyTask('BID-CONTRACT');
    // 发布最后阶段（价格对比表）要求已保存计价方式与效益分析
    await ctx.prisma.procurementPriceCompare.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        pricingMethod: 'FIXED',
        benefitAnalysis: '<p>集成测试</p>',
      } as any,
    });

    const a = `成交甲-${uniq('a')}`;
    const b = `成交乙-${uniq('b')}`;
    await taskService.importResultReport(
      task.id,
      await bidderXlsx([supplier(a, 1000, 900), supplier(b, 1100, 980), supplier(`未中-${uniq('c')}`, 1200, 1150)]),
    );
    await taskService.saveResultReport(task.id, {
      candidates: [
        { supplierIndex: 0, name: a, finalPreTaxPrice: 900000 },
        { supplierIndex: 1, name: b, finalPreTaxPrice: 980000 },
      ],
    });

    // ⚠️ 关键判据：把**发布快照**改成与结构化行不一致（去掉乙、加一个不存在的单位、价格改 1）。
    // 生成合同必须只看结构化行（中标行）——若退回成"读 JSON candidates"的实现，本用例会红。
    await ctx.prisma.procurementResultReport.update({
      where: { taskId: task.id },
      data: { candidates: JSON.stringify([{ supplierIndex: 0, name: `陈旧快照-${uniq('old')}`, finalPreTaxPrice: 1 }]) },
    });

    // 前置确认：此刻确实停在最后阶段（发布后即触发合同生成）
    const before = await ctx.prisma.procurementTask.findUnique({ where: { id: task.id } });
    assert.equal(before?.stage, stage);

    await taskService.publish(task.id, { userId: 'int-test' });

    const contracts = await ctx.prisma.contract.findMany({ where: { taskId: task.id } });
    assert.equal(contracts.length, 2, '两个中标单位应生成两份合同（未中标的不生成；陈旧快照也不该被采信）');
    const amounts = contracts.map((c) => Number(c.amount)).sort((x, y) => x - y);
    assert.deepEqual(amounts, [900000, 980000], '合同金额应取自结构化行的最终确认价（不是 JSON 快照里的 1）');
    assert.equal(typeof contracts[0].code, 'string');
    assert.ok(String(contracts[0].code).length > 0, '合同编号应已生成');
    // 状态与关联：草稿态、关联本任务
    for (const c of contracts) {
      assert.equal(c.status, CONTRACT_STATUS.DRAFT);
      assert.equal(c.taskId, task.id);
    }
    // 供应商按名称解析到了供应商库（未入库则为 null，这里没建供应商库记录，故为 null 属预期）
    assert.ok(contracts.every((c) => c.supplierId === null || typeof c.supplierId === 'string'));
  });
});
