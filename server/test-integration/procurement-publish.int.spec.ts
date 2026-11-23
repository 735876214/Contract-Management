// @domains: procurement, contract
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { ProcurementTaskService } from '../src/modules/procurement/procurement-task.service';
import { requestContext } from '../src/common/services/request-context';

/**
 * 集成测试 · **采购发布主链 + 项目隔离 fail-closed**（真库、真发布）。
 *
 * 为什么需要：`publish()` 一个方法要推进阶段、回填本阶段 `publishedAt`、够数时自动生成草稿合同，
 * 纯函数单测只能证明 `procurementFlow.ts` 的阶段链算得对，**证明不了门禁真的接在发布上**
 * （`procurement-forms.int.spec.ts` 覆盖的是六阶段表单往返与预计金额口径，不含发布与隔离）。
 *
 * 覆盖：
 * ① 总清单未编制 → `publish()` 必须 400，且 stage **不变**（门禁 + 事务生效的最小断言）；
 * ② 编制总清单 → 发布 → 阶段推进 + 自动生成 1 份草稿合同（类型由采购类型派生）+ 量价带入合同起草清单；
 * ③ 项目隔离 fail-closed（2026-11-22 审计）：别项目上下文按 id 读 → 404；
 *    请求内**漏带项目头** → 400 + code 1412，而不是把过滤放宽后"读到别人的任务"。
 */

describe('集成 · 采购发布主链（紧急采购）+ 项目隔离', () => {
  let ctx: IntContext;
  let svc: ProcurementTaskService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<ProcurementTaskService>(ProcurementTaskService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 建项目（合同编号要「项目字母简称」段，缺了 nextCode 会报错；该列唯一，故随机后缀） */
  async function projectWithAbbr(tag: string) {
    const project = await makeProject(ctx.prisma, tag);
    const codeAbbr = `AB${Math.random().toString(36).slice(2, 8)}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
    await ctx.prisma.project.update({ where: { id: project.id }, data: { codeAbbr } });
    return project;
  }

  /** 物资基础库行（计量单位必须命中字典 measurement_unit 的 itemName） */
  const materialBase = (tag: string) =>
    ctx.prisma.materialBase.create({
      data: { name: `集成测试物资 ${uniq(tag)}`, spec: 'DN50', unit: '件' },
    });

  it('① 门禁：总清单未编制时 publish() 400，且阶段不得推进', async () => {
    const project = await projectWithAbbr('PUB-GATE');
    const task: any = await svc.create(
      { type: 'EMERGENCY', content: '集成测试-紧急采购（未编制清单）', procurementCategory: '物资' },
      project.id,
    );

    await assert.rejects(
      () => requestContext.run({ projectId: project.id }, () => svc.publish(task.id)),
      (e: unknown) => e instanceof BadRequestException,
      '未编制总清单就发布必须被拦住',
    );

    const after1: any = await ctx.prisma.procurementTask.findUnique({ where: { id: task.id } });
    assert.equal(after1?.stage, 0, '发布失败后 stage 不应变化');
  });

  it('② 编制总清单 → 发布 → 阶段推进 + 自动生成 1 份草稿合同 + 清单带入起草', async () => {
    const project = await projectWithAbbr('PUB-OK');
    const mb = await materialBase('PUB-OK');
    const task: any = await svc.create(
      { type: 'EMERGENCY', content: '集成测试-紧急采购（全流程）', procurementCategory: '物资' },
      project.id,
    );

    await requestContext.run({ projectId: project.id }, async () => {
      await svc.saveTotalList(task.id, [
        { materialBaseId: mb.id, unit: '件', qty: 10, planPrice: 900, incomePrice: 1000 } as any,
      ]);
      await svc.publish(task.id);
    });

    const detail: any = await requestContext.run({ projectId: project.id }, () => svc.findOne(task.id));
    const stages = (detail.stages || []).map((s: any) => `${s.key}:${s.state}`).join(', ');
    assert.match(stages, /TOTAL_LIST:done/, `总清单应为已完成，实际 ${stages}`);
    assert.match(stages, /CONTRACT:editing/, `合同阶段应进入编辑中，实际 ${stages}`);

    const contracts = await ctx.prisma.contract.findMany({ where: { taskId: task.id, projectId: project.id } });
    assert.equal(contracts.length, 1, '紧急采购应自动生成且只生成 1 份合同');
    assert.equal((contracts[0] as any).typeCode, 'EMERGENCY');
    assert.equal(contracts[0].status, 'DRAFT');

    const drafts = await ctx.prisma.contractDraftMaterial.findMany({ where: { contractId: contracts[0].id } });
    assert.equal(drafts.length, 1, '总清单 1 行应带入 1 行草稿清单');
    assert.equal(drafts[0].materialBaseId, mb.id);
    assert.equal(Number(drafts[0].qty), 10);
    assert.equal(Number(drafts[0].priceBeforeTax), 900, '控制价 planPrice 应作为税前单价带入');
  });

  it('③ 隔离 fail-closed：别项目上下文 → 404；请求内漏带项目头 → 400 code 1412', async () => {
    const projectA = await projectWithAbbr('PUB-ISO-A');
    const projectB = await projectWithAbbr('PUB-ISO-B');
    const task: any = await svc.create(
      { type: 'EMERGENCY', content: '集成测试-跨项目隔离', procurementCategory: '物资' },
      projectA.id,
    );

    // 本项目上下文：正常读到
    const mine: any = await requestContext.run({ projectId: projectA.id }, () => svc.findOne(task.id));
    assert.equal(mine.id, task.id);

    // 别的项目：按 id 直取 → 404（不暴露存在性）
    await assert.rejects(
      () => requestContext.run({ projectId: projectB.id }, () => svc.findOne(task.id)),
      (e: unknown) => e instanceof NotFoundException,
      '跨项目按 id 读必须 404',
    );

    // 请求内但漏带 x-project-id：400（改造前是丢掉 projectId 过滤 = 读到别人的任务）
    await assert.rejects(
      () => requestContext.run({ projectId: undefined }, () => svc.findOne(task.id)),
      (e: unknown) => {
        const err = e as { getStatus?: () => number; getResponse?: () => { code?: number } };
        return err?.getStatus?.() === 400 && err?.getResponse?.()?.code === 1412;
      },
      '请求内缺项目上下文必须 400 + code 1412',
    );
  });
});
