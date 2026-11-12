import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeTask, uniq, type IntContext } from './helpers';
import { ContractService } from '../src/modules/contract/contract.service';
import { CONTRACT_STATUS } from '../src/constants/statuses';
import { TASK_STATUS } from '../src/constants/procurementFlow';
import { requestContext } from '../src/common/services/request-context';

/**
 * 集成测试 · **合同状态流转与采购任务状态联动**（真库、真守卫、真联动）。
 *
 * 覆盖（对应用户点名的「状态流转」）：
 * ① 草稿 →(提交/互转) 待签章 →(签章) 已签章 →(驳回) 草稿，每一步都断言**关联采购任务**的状态；
 * ② 签章件真的落盘且可按合同下载（走 StorageService 全链路）；
 * ③ 非法流转被状态机守卫拦住（草稿不可驳回）；
 * ④ 两条**防误改**规则：非主合同不改写任务状态、任务未走完阶段链时不介入。
 *
 * 注：项目**没有多级流程引擎**（无 `Approval*` 表，合同 = status + /sign + /reject），
 * 所以这里验的是「提交 → 待签章 → 签章 / 驳回」这条既有状态流转。
 */
describe('集成 · 合同状态流转与任务联动', () => {
  let ctx: IntContext;
  let contract: ContractService;

  before(async () => {
    ctx = await bootIntApp();
    contract = ctx.get<ContractService>(ContractService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('草稿 → 待签章 → 签章 → 驳回：合同与采购任务状态同步', async () => {
    const project = await makeProject(ctx.prisma, 'FLOW');
    // stage 设大值 = 阶段链已走完（否则合同状态不该改写任务状态）
    const task = await makeTask(ctx.prisma, { projectId: project.id, type: 'SINGLE', status: TASK_STATUS.CONTRACT_EDITING, stage: 99 });
    const c = await makeContract(ctx.prisma, { projectId: project.id, taskId: task.id, status: CONTRACT_STATUS.DRAFT, amount: 1000 });

    // ① 草稿 → 待签章
    await contract.setStatus(c.id, CONTRACT_STATUS.APPROVING);
    assert.equal((await ctx.prisma.contract.findUnique({ where: { id: c.id } }))?.status, CONTRACT_STATUS.APPROVING);
    assert.equal(
      (await ctx.prisma.procurementTask.findUnique({ where: { id: task.id } }))?.status,
      TASK_STATUS.CONTRACT_APPROVING,
      '待签章 → 任务应为「合同待签章」',
    );

    // ② 签章（真的落盘 + 可下载）
    const pdf = Buffer.from('%PDF-1.4\n% 集成测试签章件\n%%EOF\n', 'utf8');
    const signed = await contract.sign(
      c.id,
      { buffer: pdf, originalname: 'int-signed.pdf', size: pdf.length },
      '2026-01-15',
      '集成测试',
    );
    assert.equal(signed.status, CONTRACT_STATUS.SIGNED);
    assert.match(String(signed.signedFilePath || ''), /^signed\/.+\.pdf$/, '签章件键应为 signed/<文件>（相对 POSIX 路径）');
    assert.equal(
      (await ctx.prisma.procurementTask.findUnique({ where: { id: task.id } }))?.status,
      TASK_STATUS.COMPLETED,
      '已签章 → 任务应为「已完成」',
    );
    const dl = await contract.signedFile(c.id);
    assert.ok((dl.buffer as Buffer).equals(pdf), '下载到的签章件应与上传内容逐字节一致');

    // ②-2 重新签章只改签订日期（不传新文件）：沿用原签章件，不清空原件
    const resigned = await contract.sign(c.id, null, '2026-01-20', '只改签订日期');
    assert.equal(resigned.status, CONTRACT_STATUS.SIGNED);
    assert.equal(resigned.signedFilePath, signed.signedFilePath, '未上传新文件时应沿用原签章件');
    assert.equal(
      new Date(resigned.signDate as any).toISOString().slice(0, 10),
      '2026-01-20',
      '签订日期应被更新',
    );

    // ③ 驳回回起草
    await contract.rejectToDraft(c.id);
    const after = await ctx.prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(after?.status, CONTRACT_STATUS.DRAFT);
    assert.equal(after?.signedFilePath, null, '驳回应清掉签章件引用');
    assert.equal(
      (await ctx.prisma.procurementTask.findUnique({ where: { id: task.id } }))?.status,
      TASK_STATUS.CONTRACT_EDITING,
      '驳回 → 任务应回到「合同编制中」',
    );

    // ④ 非法流转：草稿不可再驳回
    await assert.rejects(
      () => contract.rejectToDraft(c.id),
      (e: any) => e instanceof BadRequestException && /驳回/.test(e.message),
      '草稿状态应被守卫拒绝',
    );
    // ⑤ 非法状态取值
    await assert.rejects(() => contract.setStatus(c.id, 'WHATEVER'), (e: any) => e instanceof BadRequestException);
  });

  it('防误改：非主合同不改写任务状态；任务未走完阶段链时不介入', async () => {
    const project = await makeProject(ctx.prisma, 'FLOW-GUARD');
    const task = await makeTask(ctx.prisma, { projectId: project.id, type: 'SINGLE', status: TASK_STATUS.CONTRACT_EDITING, stage: 99 });
    const main = await makeContract(ctx.prisma, { projectId: project.id, taskId: task.id, status: CONTRACT_STATUS.DRAFT });
    // 主合同先进行态：稍后以「非主合同」身份改状态，任务状态不该跟着变
    await contract.setStatus(main.id, CONTRACT_STATUS.APPROVING);
    assert.equal((await ctx.prisma.procurementTask.findUnique({ where: { id: task.id } }))?.status, TASK_STATUS.CONTRACT_APPROVING);

    const second = await makeContract(ctx.prisma, { projectId: project.id, taskId: task.id, status: CONTRACT_STATUS.DRAFT });
    /**
     * 「已签章」只能由签章动作产生：第 13/14 轮审计把 `setStatus(..., SIGNED)` 封了
     * （只写 status 会得到「已签章但没有签章件原件」的合同）。所以这里走真实签章路径，
     * 本用例要验的仍然是「非主合同的状态变化不改写任务状态」。
     */
    const pdf2 = Buffer.from('%PDF-1.4\n% 集成测试签章件（非主合同）\n%%EOF\n', 'utf8');
    const signedSecond = await contract.sign(
      second.id,
      { buffer: pdf2, originalname: 'int-nonmain.pdf', size: pdf2.length },
      '2026-01-16',
      '集成测试',
    );
    assert.equal(signedSecond.status, CONTRACT_STATUS.SIGNED, '非主合同签章后自身应为已签章');
    assert.equal(
      (await ctx.prisma.procurementTask.findUnique({ where: { id: task.id } }))?.status,
      TASK_STATUS.CONTRACT_APPROVING,
      '非主合同的状态变化不得改写任务状态（任务状态跟随主合同）',
    );

    // 阶段链未走完（stage=0）：任务状态仍由阶段进度决定，合同状态不介入
    const early = await makeTask(ctx.prisma, { projectId: project.id, type: 'SINGLE', status: TASK_STATUS.LIST_EDITING, stage: 0 });
    const earlyContract = await makeContract(ctx.prisma, { projectId: project.id, taskId: early.id, status: CONTRACT_STATUS.DRAFT });
    await contract.setStatus(earlyContract.id, CONTRACT_STATUS.APPROVING);
    assert.equal(
      (await ctx.prisma.procurementTask.findUnique({ where: { id: early.id } }))?.status,
      TASK_STATUS.LIST_EDITING,
      '任务未走完阶段链时，合同状态不应介入',
    );
  });

  /**
   * 跨项目按 id 直达（2026-11-12 续审 R5 新增）：合同子资源此前只校验"合同存在"，
   * 持本项目 contract:edit 的用户换个 id 就能读写/发布他项目的合同。
   */
  it('合同子资源校验项目归属：跨项目详情/变更/扩展/发布一律 404', async () => {
    const projectA = await makeProject(ctx.prisma, 'ISO-A');
    const projectB = await makeProject(ctx.prisma, 'ISO-B');
    const contractB = await makeContract(ctx.prisma, {
      projectId: projectB.id,
      status: CONTRACT_STATUS.APPROVING,
      amount: 1000,
    });
    const taskB = await makeTask(ctx.prisma, { projectId: projectB.id });

    await requestContext.run({ projectId: projectA.id }, async () => {
      const is404 = (e: any) => e instanceof NotFoundException;
      await assert.rejects(() => contract.findOne(contractB.id), is404, '合同详情');
      await assert.rejects(() => contract.changes(contractB.id), is404, '变更日志');
      await assert.rejects(() => contract.getExt(contractB.id), is404, '扩展信息');
      await assert.rejects(() => contract.draftList(contractB.id), is404, '草稿清单');
      await assert.rejects(() => contract.publish(contractB.id), is404, '发布');
      await assert.rejects(() => contract.signedFile(contractB.id), is404, '签章件下载');
      // 跨项目关联采购任务：不允许把本合同的变更联动进别项目的任务
      await assert.rejects(
        () =>
          contract.create(
            { code: uniq('INT-HT').toUpperCase(), name: '跨项目任务合同', taskId: taskB.id },
            projectA.id,
            { userId: 'int-test' },
          ),
        (e: any) => e instanceof BadRequestException && /采购任务/.test(e.message),
        '跨项目 taskId',
      );
    });

    // 本项目的请求上下文不受影响
    const ok = await requestContext.run({ projectId: projectB.id }, () => contract.findOne(contractB.id));
    assert.equal(ok.id, contractB.id);
  });

  it('已签章合同不能被重新发布（状态机不回退）', async () => {
    const project = await makeProject(ctx.prisma, 'PUB-GUARD');
    const c = await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });
    await ctx.prisma.contract.update({ where: { id: c.id }, data: { status: CONTRACT_STATUS.SIGNED } });
    await requestContext.run({ projectId: project.id }, async () => {
      await assert.rejects(
        () => contract.publish(c.id),
        (e: any) => e instanceof BadRequestException && /已签章/.test(e.message),
      );
    });
    const after = await ctx.prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(after?.status, CONTRACT_STATUS.SIGNED, '发布被拒绝后状态不得变化');
  });

  it('草稿清单保存只能写本合同的行（跨合同行 id 一律 404）', async () => {
    const project = await makeProject(ctx.prisma, 'DRAFT-ROW');
    const c1 = await makeContract(ctx.prisma, { projectId: project.id });
    const c2 = await makeContract(ctx.prisma, { projectId: project.id });
    const mb = await ctx.prisma.materialBase.create({
      data: { name: uniq('INT-MAT'), spec: 'S' },
    });
    const rowOfC2 = await ctx.prisma.contractDraftMaterial.create({
      data: { contractId: c2.id, materialBaseId: mb.id, unit: '', sortOrder: 1 },
    });
    await requestContext.run({ projectId: project.id }, async () => {
      await assert.rejects(
        () => contract.draftSave(c1.id, [{ id: rowOfC2.id, qty: 1 }]),
        (e: any) => e instanceof NotFoundException,
      );
    });
    // 原本的取值未被改动
    const row = await ctx.prisma.contractDraftMaterial.findUnique({ where: { id: rowOfC2.id } });
    assert.equal(row?.qty, null);
  });
});
