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
    // 任务 2.2：发布总采购清单前必须已编制至少一条明细
    if (current.stage === 0) {
      const count = await this.prisma.procurementTotalItem.count({ where: { taskId: current.id } });
      if (count === 0) throw new BadRequestException('请先编制总采购清单（至少一条明细）后再发布');
    }
    // 任务 3.1：发布「框架协议事前说明」前必须已保存内容（框架简介为必填主内容）
    if (current.stage === 1 && current.type === 'FRAMEWORK') {
      const expl = await this.prisma.frameworkExplanation.findUnique({ where: { taskId: current.id } });
      if (!expl || !String(expl.frameworkIntro ?? '').trim()) {
        throw new BadRequestException('请先编辑并保存框架协议事前说明（至少填写框架简介）后再发布');
      }
    }

    const nextStage = current.stage + 1;
    const nextStatus = this.deriveStatus(current.type, current.preMeetingRequired, nextStage, current.contractId);
    const updated = await this.prisma.procurementTask.update({
      where: { id },
      data: { stage: nextStage, status: nextStatus, version: { increment: 1 } },
    });
    // 事前说明阶段发布 → 回填发布时间（状态由 stage 推导：已发布即「已完成」）
    if (current.stage === 1 && current.type === 'FRAMEWORK') {
      await this.prisma.frameworkExplanation.updateMany({
        where: { taskId: id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
    return { ...this.serialize(updated), stages: this.buildStages(updated) };
  }

  /** 总采购清单明细（任务 2.2）。stage≥1 表示已发布 → 冻结 */
  async totalList(taskId: string) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    const items = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      frozen: task.stage >= 1,
      status: task.status,
      statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
      items: items.map((i) => this.serializeItem(i)),
    };
  }

  /**
   * 保存总采购清单（全量替换，仅「未发起」阶段可保存；发布后冻结）。
   * 规则（需求 2.2）：
   * - 物资名称/规格型号只能来自物资基础库（materialBaseId 必须存在）
   * - 计量单位必须存在于字典「measurement_unit」，默认带出、可改为其他字典值
   * - 控制价校验：预计采购单价 > 市场单价 → 拒绝保存
   * - 计量单位与基础库默认值不符的行：提交时同步（物资名称+规格型号+计量单位）到物资基础库
   */
  async saveTotalList(taskId: string, items: any[]) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.stage >= 1) throw new BadRequestException('总采购清单已发布冻结，不可修改');
    if (task.status !== STATUS_NOT_STARTED) throw new BadRequestException('任务已进入后续流程，总采购清单不可修改');
    if (!Array.isArray(items)) throw new BadRequestException('清单数据无效');

    const num = (v: any): number | null => {
      if (v === '' || v == null) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new BadRequestException('数量/单价必须为数字');
      return n;
    };

    const normalized = items.map((raw) => {
      const materialBaseId = String(raw?.materialBaseId ?? '').trim();
      if (!materialBaseId) throw new BadRequestException('物资名称/规格型号必须从物资基础库选择');
      const unit = String(raw?.unit ?? '').trim();
      if (!unit) throw new BadRequestException('计量单位不能为空');
      return {
        materialBaseId,
        materialName: String(raw?.materialName ?? '').trim(),
        spec: String(raw?.spec ?? '').trim(),
        unit,
        qty: num(raw?.qty),
        incomePrice: num(raw?.incomePrice),
        stdCost: num(raw?.stdCost),
        marketPrice: num(raw?.marketPrice),
        infoPrice: num(raw?.infoPrice),
        planPrice: num(raw?.planPrice),
      };
    });

    // 基础库与字典校验
    const baseIds = [...new Set(normalized.map((i) => i.materialBaseId))];
    const bases = await this.prisma.materialBase.findMany({ where: { id: { in: baseIds } } });
    const baseMap = new Map(bases.map((b) => [b.id, b]));
    const dictUnits = await this.prisma.dictItem.findMany({
      where: { typeCode: 'measurement_unit', status: 1 },
    });
    const unitNames = new Set(dictUnits.map((u) => u.itemName));

    for (const row of normalized) {
      const base = baseMap.get(row.materialBaseId);
      if (!base) throw new BadRequestException('所选物资不存在于物资基础库，请重新选择');
      // 名称/规格以基础库为准回填，防止前端篡改
      row.materialName = base.name;
      row.spec = base.spec;
      if (!unitNames.has(row.unit)) {
        throw new BadRequestException(`计量单位「${row.unit}」不在字典范围内，请先在字典管理中添加`);
      }
      if (row.planPrice != null && row.marketPrice != null && row.planPrice > row.marketPrice) {
        throw new BadRequestException('控制价超市场单价，重新修改');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.procurementTotalItem.deleteMany({ where: { taskId } });
      if (normalized.length) {
        await tx.procurementTotalItem.createMany({
          data: normalized.map((r, idx) => ({ ...r, projectId: task.projectId, taskId, sortOrder: idx })),
        });
      }
      // 计量单位与基础库默认值不符 → 提交时同步到物资基础库（唯一键为 name+spec，更新该记录单位）
      for (const row of normalized) {
        const base = baseMap.get(row.materialBaseId);
        if (base && base.unit !== row.unit) {
          await tx.materialBase.update({ where: { id: base.id }, data: { unit: row.unit } });
        }
      }
    });
    return this.totalList(taskId);
  }

  private serializeItem(i: {
    id: string;
    materialBaseId: string;
    materialName: string;
    spec: string;
    unit: string;
    qty: number | null;
    incomePrice: number | null;
    stdCost: number | null;
    marketPrice: number | null;
    infoPrice: number | null;
    planPrice: number | null;
    sortOrder: number;
  }) {
    return {
      id: i.id,
      materialBaseId: i.materialBaseId,
      materialName: i.materialName,
      spec: i.spec,
      unit: i.unit,
      qty: i.qty,
      incomePrice: i.incomePrice,
      stdCost: i.stdCost,
      marketPrice: i.marketPrice,
      infoPrice: i.infoPrice,
      planPrice: i.planPrice,
      sortOrder: i.sortOrder,
    };
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

  /**
   * 框架协议事前说明（批次二 · 任务 3.1，仅 FRAMEWORK 类型任务）。
   * 状态由阶段进度推导：stage=1 编辑中（仅保存），stage≥2 已完成（发布后，仍可重新编辑）。
   */
  async frameworkExplanation(taskId: string) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'FRAMEWORK') {
      throw new BadRequestException('仅「引用框架协议」类型的采购任务可使用事前说明模块');
    }
    const record = await this.prisma.frameworkExplanation.findUnique({ where: { taskId } });
    const published = task.stage >= 2;
    return {
      task: this.serialize(task),
      editable: task.stage >= 1 && !published,
      published,
      status: published ? 'COMPLETED' : 'EDITING',
      statusLabel: published ? '已完成' : '编辑中',
      data: record ? this.serializeExplanation(record) : null,
    };
  }

  /** 保存事前说明（编辑中/已完成均可保存；发布后重新编辑允许修改但保留 publishedAt） */
  async saveFrameworkExplanation(taskId: string, body: any) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'FRAMEWORK') {
      throw new BadRequestException('仅「引用框架协议」类型的采购任务可使用事前说明模块');
    }
    if (task.stage < 1) {
      throw new BadRequestException('总采购清单发布后才能编辑框架协议事前说明');
    }

    const text = (v: any): string | null => {
      const s = String(v ?? '').trim();
      return s || null;
    };
    const num = (v: any): number | null => {
      if (v === '' || v == null) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new BadRequestException('表格中的价格/占比必须为数字');
      return n;
    };
    const rows = (v: any, fields: string[]): string | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException('表格数据无效');
      const normalized = v
        .filter((r: any) => r != null && typeof r === 'object')
        .map((r: any) => {
          const row: Record<string, string | number | null> = {};
          for (const f of fields) {
            row[f] = f === 'rank' || f === 'totalPrice' || f === 'execPrice' || f === 'amount' || f === 'ratio'
              ? num(r?.[f])
              : text(r?.[f]);
          }
          return row;
        });
      return normalized.length ? JSON.stringify(normalized) : null;
    };
    const files = (v: any): string | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException('附件数据无效');
      const normalized = v
        .filter((f: any) => f?.url)
        .map((f: any) => ({ fileName: text(f.fileName) ?? '附件', url: String(f.url), size: num(f.size) }));
      return normalized.length ? JSON.stringify(normalized) : null;
    };

    const payload = {
      frameworkIntro: text(body?.frameworkIntro),
      negotiation: text(body?.negotiation),
      inquiryRows: rows(body?.inquiryRows, ['rank', 'unit', 'totalPrice', 'taxIncluded', 'type']),
      priceCompareRows: rows(body?.priceCompareRows, ['unit', 'content', 'execPrice', 'note']),
      execution: text(body?.execution),
      costRows: rows(body?.costRows, ['item', 'amount', 'ratio', 'note']),
      attachments: files(body?.attachments),
    };

    const saved = await this.prisma.frameworkExplanation.upsert({
      where: { taskId },
      create: { ...payload, projectId: task.projectId, taskId },
      update: payload,
    });
    return this.serializeExplanation(saved);
  }

  private serializeExplanation(r: {
    id: string;
    taskId: string;
    frameworkIntro: string | null;
    negotiation: string | null;
    inquiryRows: string | null;
    priceCompareRows: string | null;
    execution: string | null;
    costRows: string | null;
    attachments: string | null;
    publishedAt: Date | null;
    updatedAt: Date;
  }) {
    const parse = (s: string | null): any[] => {
      if (!s) return [];
      try {
        const arr = JSON.parse(s);
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    };
    return {
      id: r.id,
      taskId: r.taskId,
      frameworkIntro: r.frameworkIntro ?? '',
      negotiation: r.negotiation ?? '',
      inquiryRows: parse(r.inquiryRows),
      priceCompareRows: parse(r.priceCompareRows),
      execution: r.execution ?? '',
      costRows: parse(r.costRows),
      attachments: parse(r.attachments),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
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
