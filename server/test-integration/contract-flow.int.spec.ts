import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { bootIntApp, makeContract, makeProject, makeTask, type IntContext } from './helpers';
import { ContractService } from '../src/modules/contract/contract.service';
import { CONTRACT_STATUS } from '../src/constants/statuses';
import { TASK_STATUS } from '../src/constants/procurementFlow';

/**
 * 集成测试 · **合同状态流转与采购任务状态联动**（真库、真守卫、真联动）。
 *
 * 覆盖（对应用户点名的「状态流转」）：
 * ① 草稿 →(提交/互转) 审批中 →(签章) 已签章 →(驳回) 草稿，每一步都断言**关联采购任务**的状态；
 * ② 签章件真的落盘且可按合同下载（走 StorageService 全链路）；
 * ③ 非法流转被状态机守卫拦住（草稿不可驳回）；
 * ④ 两条**防误改**规则：非主合同不改写任务状态、任务未走完阶段链时不介入。
 *
 * 注：项目**无审批流模型**（无 `Approval*` 表，合同 = status + /sign + /reject），
 * 所以「审批逻辑」在这里体现为「提交 → 审批中 → 签章 / 驳回」这条既有流转（见 docs/09 §2.2 F）。
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

  it('草稿 → 审批中 → 签章 → 驳回：合同与采购任务状态同步', async () => {
    const project = await makeProject(ctx.prisma, 'FLOW');
    // stage 设大值 = 阶段链已走完（否则合同状态不该改写任务状态）
    const task = await makeTask(ctx.prisma, { projectId: project.id, type: 'SINGLE', status: TASK_STATUS.CONTRACT_EDITING, stage: 99 });
    const c = await makeContract(ctx.prisma, { projectId: project.id, taskId: task.id, status: CONTRACT_STATUS.DRAFT, amount: 1000 });

    // ① 草稿 → 审批中
    await contract.setStatus(c.id, CONTRACT_STATUS.APPROVING);
    assert.equal((await ctx.prisma.contract.findUnique({ where: { id: c.id } }))?.status, CONTRACT_STATUS.APPROVING);
    assert.equal(
      (await ctx.prisma.procurementTask.findUnique({ where: { id: task.id } }))?.status,
      TASK_STATUS.CONTRACT_APPROVING,
      '审批中 → 任务应为「合同审批中」',
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
    await contract.setStatus(second.id, CONTRACT_STATUS.SIGNED);
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
});
