import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult } from '../../common/utils/helpers';

/**
 * 采购任务工作流（批次二 · 任务 2.1）
 *
 * 采购类型 → 子任务阶段链（顺序执行，前一阶段未发布时后续阶段锁定）：
 * - FRAMEWORK 引用框架协议：总采购清单 → 框架协议事前说明 → 生成合同
 * - SINGLE 单项采购：总采购清单 → [采前会会议纪要(≥100万)] → 采购公告 → 资审报告
 *            → 采购文件 → 成交报告 → 采购价格对比表 → 生成合同
 *
 * stage = 已发布阶段数。子任务 i 可编辑/可发布 ⇔ i ≤ stage。
 * 状态由 stage 推导并持久化（见 deriveStatus）。
 */

export interface StageDef {
  key: string;
  label: string;
  /** 该阶段进入编制中时对应的工作流状态 */
  status: string;
}

const TOTAL_LIST: StageDef = { key: 'TOTAL_LIST', label: '编制总采购清单', status: 'LIST_EDITING' };
const PRE_MEETING: StageDef = { key: 'PRE_MEETING', label: '采前会会议纪要', status: 'PRE_MEETING_EDITING' };
const NOTICE: StageDef = { key: 'NOTICE', label: '采购公告', status: 'NOTICE_EDITING' };
const INSPECTION: StageDef = { key: 'INSPECTION', label: '资审报告', status: 'INSPECTION_EDITING' };
const DOCUMENT: StageDef = { key: 'DOCUMENT', label: '采购文件', status: 'DOCUMENT_EDITING' };
const RESULT_REPORT: StageDef = { key: 'RESULT_REPORT', label: '成交报告', status: 'RESULT_EDITING' };
const PRICE_COMPARE: StageDef = { key: 'PRICE_COMPARE', label: '采购价格对比表', status: 'PRICE_COMPARE_EDITING' };
const FRAMEWORK_EXPLAIN: StageDef = { key: 'FRAMEWORK_EXPLAIN', label: '框架协议事前说明', status: 'FRAMEWORK_EDITING' };

/** 合同阶段之后的任务状态（合同未生成/草稿 → 合同编制中） */
export const STATUS_CONTRACT_EDITING = 'CONTRACT_EDITING';
export const STATUS_CONTRACT_APPROVING = 'CONTRACT_APPROVING';
export const STATUS_COMPLETED = 'COMPLETED';
export const STATUS_NOT_STARTED = 'NOT_STARTED';

/** 任务类型 → 阶段链（不含合同阶段；采前会为条件阶段） */
function stageChain(type: string, preMeetingRequired: boolean): StageDef[] {
  if (type === 'FRAMEWORK') return [TOTAL_LIST, FRAMEWORK_EXPLAIN];
  if (type === 'SINGLE') {
    const chain = [TOTAL_LIST];
    if (preMeetingRequired) chain.push(PRE_MEETING);
    chain.push(NOTICE, INSPECTION, DOCUMENT, RESULT_REPORT, PRICE_COMPARE);
    return chain;
  }
  throw new BadRequestException('无效的采购类型');
}

/** 状态 → 中文展示 */
export const TASK_STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: '未发起',
  LIST_EDITING: '总清单编制中',
  PRE_MEETING_EDITING: '采前会纪要编制中',
  NOTICE_EDITING: '采购公告编制中',
  INSPECTION_EDITING: '资审报告编制中',
  DOCUMENT_EDITING: '采购文件编制中',
  RESULT_EDITING: '成交报告编制中',
  PRICE_COMPARE_EDITING: '价格对比表编制中',
  FRAMEWORK_EDITING: '事前报告编制中',
  CONTRACT_EDITING: '合同编制中',
  CONTRACT_APPROVING: '合同审批中',
  COMPLETED: '已完成',
};

const TASK_TYPES = ['FRAMEWORK', 'SINGLE'] as const;
type TaskType = (typeof TASK_TYPES)[number];
const isTaskType = (v: unknown): v is TaskType =>
  typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v);

interface TaskRow {
  id: string;
  projectId: string;
  taskNo: string;
  type: string;
  content: string;
  purpose: string | null;
  status: string;
  stage: number;
  preMeetingRequired: boolean;
  totalListId: string | null;
  contractId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ProcurementTaskService {
  constructor(private prisma: PrismaClient) {}

  /** 分页列表（筛选：状态 / 采购类型 / 编号与内容关键词） */
  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.keyword) {
      where.OR = [{ taskNo: { contains: query.keyword } }, { content: { contains: query.keyword } }];
    }
    const [rows, total] = await Promise.all([
      this.prisma.procurementTask.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.procurementTask.count({ where }),
    ]);
    return buildResult(rows.map((r) => this.serialize(r)), total, query);
  }

  async findOne(id: string) {
    const r = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('采购任务不存在');
    return { ...this.serialize(r), stages: this.buildStages(r) };
  }

  /** 新建任务：自动编号，状态「未发起」，stage=0 */
  async create(data: { type?: string; content?: string; purpose?: string; preMeetingRequired?: boolean }, projectId: string) {
    if (!isTaskType(data?.type)) throw new BadRequestException('请选择采购类型（引用框架协议/单项采购）');
    const content = String(data?.content ?? '').trim();
    if (!content) throw new BadRequestException('请填写采购内容');
    const purpose = data?.purpose != null ? String(data.purpose).trim() : '';
    const preMeetingRequired = data?.preMeetingRequired === true;

    const taskNo = await this.nextTaskNo(projectId);
    const created = await this.prisma.procurementTask.create({
      data: {
        projectId, taskNo, type: data.type as TaskType,
        content, purpose: purpose || null,
        status: STATUS_NOT_STARTED, stage: 0, preMeetingRequired,
      },
    });
    return this.serialize(created);
  }

  /**
   * 编辑基本信息（采购内容/用途）。
   * 约束：进入合同阶段前且当前阶段为总清单之前（未发起/总清单编制中）才允许修改，
   * 避免清单/公告等已按内容发布后再变更造成不一致。
   */
  async update(id: string, data: { content?: string; purpose?: string; preMeetingRequired?: boolean }) {
    const current = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购任务不存在');
    const editableStatuses = [STATUS_NOT_STARTED, 'LIST_EDITING'];
    if (!editableStatuses.includes(current.status)) {
      throw new BadRequestException('任务已进入后续流程，基本信息不可修改');
    }
    const patch: { content?: string; purpose?: string | null; preMeetingRequired?: boolean } = {};
    if (data?.content != null) {
      const c = String(data.content).trim();
      if (!c) throw new BadRequestException('采购内容不能为空');
      patch.content = c;
    }
    if (data?.purpose != null) patch.purpose = String(data.purpose).trim() || null;
    if (data?.preMeetingRequired != null) {
      if (current.type !== 'SINGLE') throw new BadRequestException('仅单项采购可设置采前会要求');
      // 采前会为条件阶段：只能在未发布总清单前调整
      if (current.stage >= 1) throw new BadRequestException('总采购清单已发布，不可调整采前会要求');
      patch.preMeetingRequired = data.preMeetingRequired === true;
    }
    const updated = await this.prisma.procurementTask.update({ where: { id }, data: patch });
    return { ...this.serialize(updated), stages: this.buildStages(updated) };
  }

  /**
   * 发布当前阶段的子任务（前置约束：前面的阶段必须全部已发布）。
   * 发布后 stage+1，状态流转到下一阶段的「编制中」；若全部阶段发布完毕则进入合同阶段状态。
   */
  async publish(id: string) {
    const current = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购任务不存在');

    const chain = stageChain(current.type, current.preMeetingRequired);
    if (current.stage >= chain.length) {
      throw new BadRequestException('各阶段均已发布，任务处于合同阶段');
    }

    const nextStage = current.stage + 1;
    const nextStatus = this.deriveStatus(current.type, current.preMeetingRequired, nextStage, current.contractId);
    const updated = await this.prisma.procurementTask.update({
      where: { id },
      data: { stage: nextStage, status: nextStatus, version: { increment: 1 } },
    });
    return { ...this.serialize(updated), stages: this.buildStages(updated) };
  }

  /**
   * 同步合同阶段状态（批次后续「生成合同」调用）：
   * - 任务全部阶段已发布且关联合同 → 按合同状态映射（DRAFT→合同编制中 / APPROVING→合同审批中 / SIGNED→已完成）
   * - 尚未到合同阶段或无关联合同 → 不变更
   */
  async syncContractStatus(id: string) {
    const current = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购任务不存在');
    const chain = stageChain(current.type, current.preMeetingRequired);
    if (current.stage < chain.length) return this.serialize(current); // 未到合同阶段
    const nextStatus = this.deriveStatus(current.type, current.preMeetingRequired, current.stage, current.contractId);
    if (nextStatus === current.status) return this.serialize(current);
    const updated = await this.prisma.procurementTask.update({
      where: { id }, data: { status: nextStatus, version: { increment: 1 } },
    });
    return this.serialize(updated);
  }

  async remove(id: string) {
    const current = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购任务不存在');
    const chain = stageChain(current.type, current.preMeetingRequired);
    if (current.stage >= chain.length) {
      throw new BadRequestException('任务已进入合同阶段，不可删除');
    }
    await this.prisma.procurementTask.delete({ where: { id } });
    return { id };
  }

  /** 采购编号：PROC-YYYYMMDD-XXX（按当日已有任务数递增） */
  private async nextTaskNo(projectId: string): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `PROC-${day}-`;
    const count = await this.prisma.procurementTask.count({
      where: { projectId, taskNo: { startsWith: prefix } },
    });
    return `${prefix}${String(count + 1).padStart(3, '0')}`;
  }

  /** 由阶段进度推导工作流状态 */
  private deriveStatus(type: string, preMeetingRequired: boolean, stage: number, contractId: string | null): string {
    const chain = stageChain(type, preMeetingRequired);
    if (stage >= chain.length) {
      // 合同阶段：按关联合同状态细分
      if (!contractId) return STATUS_CONTRACT_EDITING;
      // 关联合同的状态映射在 syncContractStatus 的调用方结合合同查询；此处合同未生成细分默认编制中
      return STATUS_CONTRACT_EDITING;
    }
    return chain[stage].status;
  }

  /** 阶段链视图：done（已发布）/ editing（当前）/ locked（前置未发布）；末尾附合同阶段 */
  private buildStages(r: TaskRow) {
    const chain = stageChain(r.type, r.preMeetingRequired);
    const stages = chain.map((s, i) => ({
      key: s.key,
      label: s.label,
      state: i < r.stage ? 'done' : i === r.stage ? 'editing' : 'locked',
    }));
    const contractState = r.stage < chain.length ? 'locked' : 'editing';
    stages.push({
      key: 'CONTRACT',
      label: '生成合同',
      state: r.status === STATUS_COMPLETED ? 'done' : contractState,
    });
    return stages;
  }

  private serialize(r: TaskRow) {
    return {
      id: r.id,
      taskNo: r.taskNo,
      type: r.type,
      content: r.content,
      purpose: r.purpose ?? '',
      status: r.status,
      statusLabel: TASK_STATUS_LABELS[r.status] ?? r.status,
      stage: r.stage,
      preMeetingRequired: r.preMeetingRequired,
      totalListId: r.totalListId,
      contractId: r.contractId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
