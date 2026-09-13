import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num } from '../../common/utils/helpers';
import { ExcelService } from '../../common/services/excel.service';
import {
  ImportTemplateService,
  TemplateColumn,
} from '../../common/services/import-template.service';
import { ContractService } from '../contract/contract.service';

/** 文本归一化：trim 后空串转 null（各阶段表单共用，避免重复定义） */
const textOf = (v: any): string | null => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** 数值解析：空值返回 null，非数字或低于下限时按业务标签抛错（各阶段表单共用） */
const numOf =
  (label: string, opts: { min?: number } = {}) =>
  (v: any): number | null => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new BadRequestException(`${label}必须为数字`);
    if (opts.min != null && n < opts.min) throw new BadRequestException(`${label}不能为负数`);
    return n;
  };

/** 整数解析：空值返回 null，非整数或低于下限时按业务标签抛错（各阶段表单共用） */
const intOf =
  (label: string, opts: { min?: number } = {}) =>
  (v: any): number | null => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new BadRequestException(`${label}必须为整数`);
    if (opts.min != null && n < opts.min) throw new BadRequestException(`${label}不能为负数`);
    return n;
  };

/** 日期解析：空值返回 null，非法格式按业务标签抛错（各阶段表单共用） */
const dateOf = (label: string) => (v: any): Date | null => {
  if (v === '' || v == null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label}格式无效`);
  return d;
};

/**
 * 采购任务工作流（批次二 · 任务 2.1）
 *
 * 采购类型 → 子任务阶段链（顺序执行，前一阶段未发布时后续阶段锁定）：
 * - FRAMEWORK 引用框架协议：总采购清单 → 框架协议事前说明 → 生成合同
 * - SINGLE 单项采购：总采购清单 → [采前会会议纪要(≥100万)] → 采购公告 → 采购文件
 *            → 成交报告 → 采购价格对比表 → 生成合同
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
const DOCUMENT: StageDef = { key: 'DOCUMENT', label: '采购文件', status: 'DOCUMENT_EDITING' };
const RESULT_REPORT: StageDef = { key: 'RESULT_REPORT', label: '成交报告', status: 'RESULT_EDITING' };
const PRICE_COMPARE: StageDef = { key: 'PRICE_COMPARE', label: '采购价格对比表', status: 'PRICE_COMPARE_EDITING' };
const FRAMEWORK_EXPLAIN: StageDef = { key: 'FRAMEWORK_EXPLAIN', label: '框架协议事前说明', status: 'FRAMEWORK_EDITING' };

/**
 * 任务 3.2：采前会会议纪要生成阈值（预计采购金额，单位：元）。
 * 单项采购预计采购金额 ≥ 100 万元时生成采前会会议纪要模块，< 100 万不生成。
 */
export const PRE_MEETING_THRESHOLD_YUAN = 1_000_000;

/**
 * 任务 3.3：采购公告阶段在阶段链中的下标。
 * 单项采购：无采前会 → 1（总清单之后）；有采前会 → 2（采前会纪要之后）。
 * 「采购公告编制中」⇔ status=NOTICE_EDITING ⇔ stage === noticeStageIndex(task)。
 */
export function noticeStageIndex(task: { type: string; preMeetingRequired: boolean }): number {
  return stageChain(task.type, task.preMeetingRequired).findIndex((s) => s.key === NOTICE.key);
}

/**
 * 任务 3.4：采购文件阶段在阶段链中的下标。
 * 单项采购：无采前会 → 2（采购公告之后）；有采前会 → 3。
 * 「采购文件编制中」⇔ status=DOCUMENT_EDITING ⇔ stage === documentStageIndex(task)，
 * 即入口条件为「采购公告已完成」。
 */
export function documentStageIndex(task: { type: string; preMeetingRequired: boolean }): number {
  return stageChain(task.type, task.preMeetingRequired).findIndex((s) => s.key === DOCUMENT.key);
}

/**
 * 任务 3.5：成交报告阶段在阶段链中的下标。
 * 单项采购：无采前会 → 3（采购文件之后）；有采前会 → 4。
 * 「成交报告编制中」⇔ status=RESULT_EDITING ⇔ stage === resultReportStageIndex(task)，
 * 即入口条件为「采购文件已完成」。
 */
export function resultReportStageIndex(task: { type: string; preMeetingRequired: boolean }): number {
  return stageChain(task.type, task.preMeetingRequired).findIndex((s) => s.key === RESULT_REPORT.key);
}

/**
 * 任务 3.6：采购价格对比表阶段在阶段链中的下标。
 * 单项采购：无采前会 → 4（成交报告之后）；有采前会 → 5。
 * 「价格对比表编制中」⇔ status=PRICE_COMPARE_EDITING ⇔ stage === priceCompareStageIndex(task)，
 * 即入口条件为「成交报告已完成」。
 */
export function priceCompareStageIndex(task: { type: string; preMeetingRequired: boolean }): number {
  return stageChain(task.type, task.preMeetingRequired).findIndex((s) => s.key === PRICE_COMPARE.key);
}

/** 元 → 万元（保留 2 位小数） */
const toWan = (yuan: number): number =>
  Math.round(((yuan || 0) / 10000 + Number.EPSILON) * 100) / 100;

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
    // 任务 3.4：采购文件紧随采购公告；任务 3.5：成交报告紧随采购文件；
    // 任务 3.6：采购价格对比表紧随成交报告，
    // 使「采购文件」的入口条件正是「采购公告已完成」，
    // 「成交报告」的入口条件正是「采购文件已完成」，
    // 「采购价格对比表」的入口条件正是「成交报告已完成」。
    chain.push(NOTICE, DOCUMENT, RESULT_REPORT, PRICE_COMPARE);
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
  procurementCategory: string | null;
  techQuality: string | null;
  acceptanceMethod: string | null;
  paymentMethod: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ProcurementTaskService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private tpl: ImportTemplateService,
    private contractService: ContractService,
  ) {}

  /**
   * 列表页联表配置（六模块列表化）：module 参数 → Prisma 关联名 + 列表需要返回的字段。
   * 模块状态由前端按 module 记录推导：无记录=未填写、有记录未发布=编辑中、已发布=已完成。
   */
  private static readonly MODULE_LIST_RELATIONS: Record<
    string,
    { rel: string; select: Record<string, boolean> }
  > = {
    FRAMEWORK_EXPLANATION: {
      rel: 'frameworkExplanation',
      select: { publishedAt: true, referenceSuppliers: true },
    },
    PRE_MEETING: {
      rel: 'preMeetingMinutes',
      select: { meetingTime: true, host: true, writer: true, publishedAt: true },
    },
    NOTICE: {
      rel: 'procurementNotice',
      select: { procurementNo: true, procurementTime: true, contacts: true, publishedAt: true },
    },
    DOCUMENT: {
      rel: 'procurementDocument',
      select: { procurementTime: true, responseDeposit: true, publishedAt: true },
    },
    RESULT_REPORT: {
      rel: 'procurementResultReport',
      select: { openTime: true, unitCount: true, approvedCount: true, candidates: true, publishedAt: true },
    },
    PRICE_COMPARE: {
      rel: 'procurementPriceCompare',
      select: { pricingMethod: true, publishedAt: true },
    },
  };

  /** 日期区间（from/to 均可选；to 由前端传当日 23:59:59） */
  private dateRange(from: any, to: any): any | null {
    const r: any = {};
    if (from) r.gte = new Date(from);
    if (to) r.lte = new Date(to);
    return Object.keys(r).length ? r : null;
  }

  /** 分页列表（筛选：状态 / 采购类型 / 编号与内容关键词 / 模块联表字段） */
  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.keyword) {
      where.OR = [{ taskNo: { contains: query.keyword } }, { content: { contains: query.keyword } }];
    }
    // 采前会列表：仅显示需要采前会的单项采购任务（保存总清单后按金额 ≥ 100 万自动判定）
    if (query.preMeetingRequired === 'true') where.preMeetingRequired = true;
    if (query.taskNo) where.taskNo = { contains: query.taskNo };
    if (query.content) where.content = { contains: query.content };

    // 模块联表（批次五 · 六模块列表化）
    const moduleDef = ProcurementTaskService.MODULE_LIST_RELATIONS[String(query.module ?? '')];
    if (moduleDef) {
      const rf: any = {};
      // 模块发布时间区间
      const pub = this.dateRange(query.publishedFrom, query.publishedTo);
      if (pub) rf.publishedAt = pub;
      // 模块状态筛选：PUBLISHED=已完成 / EDITING=编辑中（有记录未发布）/ UNFILLED=未填写（无记录）
      if (query.moduleStatus === 'PUBLISHED') {
        rf.publishedAt = { ...(rf.publishedAt ?? {}), not: null };
      } else if (query.moduleStatus === 'EDITING') {
        // 有记录但未发布（注意：Prisma 对一关系 publishedAt=null 也会命中无记录任务，需叠加 isNot null）
        where.AND = [...(where.AND ?? []), { [moduleDef.rel]: { isNot: null } }];
        if (!Object.keys(rf.publishedAt ?? {}).length) rf.publishedAt = null;
      } else if (query.moduleStatus === 'UNFILLED') {
        where.AND = [...(where.AND ?? []), { [moduleDef.rel]: { is: null } }];
      }
      // 各模块特有筛选
      switch (String(query.module)) {
        case 'PRE_MEETING': {
          const mt = this.dateRange(query.meetingFrom, query.meetingTo);
          if (mt) rf.meetingTime = mt;
          if (query.host) rf.host = { contains: query.host };
          break;
        }
        case 'NOTICE': {
          const nt = this.dateRange(query.procTimeFrom, query.procTimeTo);
          if (nt) rf.procurementTime = nt;
          if (query.contact) rf.contacts = { contains: query.contact };
          break;
        }
        case 'DOCUMENT': {
          const dt = this.dateRange(query.procTimeFrom, query.procTimeTo);
          if (dt) rf.procurementTime = dt;
          break;
        }
        case 'RESULT_REPORT': {
          const ot = this.dateRange(query.openFrom, query.openTo);
          if (ot) rf.openTime = ot;
          break;
        }
        case 'PRICE_COMPARE': {
          if (query.pricingMethod) rf.pricingMethod = query.pricingMethod;
          break;
        }
        default:
          break;
      }
      if (Object.keys(rf).length) where[moduleDef.rel] = rf;

      // 阶段门槛：模块列表仅返回「已到达该模块阶段」的任务（上一步未完成的任务不提前体现）。
      // 阶段推进语义：编辑模块 m 时 stage=m，发布后 stage=m+1，因此 stage >= 模块序号 ⇔ 前序阶段已完成。
      // 采前会为条件阶段：不在任务阶段链中（preMeetingRequired=false）时该分支直接排除。
      const stageKey = ProcurementTaskService.MODULE_DELETE_MODELS[String(query.module)]?.stageKey;
      if (stageKey) {
        if (String(query.module) === 'FRAMEWORK_EXPLANATION') {
          // 框架协议事前说明仅属于 FRAMEWORK 链（总清单 → 事前说明）
          if (!query.type) where.type = 'FRAMEWORK';
          const idx = stageChain('FRAMEWORK', false).findIndex((s) => s.key === stageKey);
          if (idx >= 0) where.stage = { gte: idx };
        } else {
          // 类型兜底（问题一）：其余模块均只属于单项采购任务，防止框架任务混入后详情接口 400
          if (!query.type) where.type = 'SINGLE';
          const noPm = stageChain('SINGLE', false).findIndex((s) => s.key === stageKey);
          const withPm = stageChain('SINGLE', true).findIndex((s) => s.key === stageKey);
          const branches: any[] = [];
          if (noPm >= 0) branches.push({ AND: [{ preMeetingRequired: false }, { stage: { gte: noPm } }] });
          if (withPm >= 0) branches.push({ AND: [{ preMeetingRequired: true }, { stage: { gte: withPm } }] });
          if (branches.length) where.AND = [...(where.AND ?? []), { OR: branches }];
        }
      }
    }

    const include: any = moduleDef ? { [moduleDef.rel]: { select: moduleDef.select } } : undefined;
    const [rows, total] = await Promise.all([
      this.prisma.procurementTask.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.procurementTask.count({ where }),
    ]);
    // 任务 3.2：列表带出预计采购金额（万元），供「是否需要采前会会议纪要」判定与展示
    const amountMap = await this.estimatedAmountMap(rows.map((r) => r.id));
    return buildResult(
      rows.map((r: any) => {
        let module: any = null;
        if (moduleDef) {
          const rec = r[moduleDef.rel];
          if (rec) {
            module = { ...rec };
            // 采购公告联系人 / 联系电话为 JSON 字符串，解析后返回
            if (String(query.module) === 'NOTICE') {
              module.contacts = this.parseJsonArray<string>(rec.contacts);
              module.contactPhones = this.parseJsonArray<string>((rec as any).contactPhones);
            }
            // 问题五：框架事前说明「引用供应商及金额」/ 成交报告「拟推荐成交候选人」JSON 解析
            if (String(query.module) === 'FRAMEWORK_EXPLANATION') {
              module.referenceSuppliers = this.parseJsonArray<Record<string, any>>(rec.referenceSuppliers);
            }
            if (String(query.module) === 'RESULT_REPORT') {
              module.candidates = this.parseJsonArray<Record<string, any>>(rec.candidates);
            }
          }
        }
        return {
          ...this.serialize(r),
          estimatedAmountWan: toWan(amountMap.get(r.id) ?? 0),
          module,
        };
      }),
      total,
      query,
    );
  }

  async findOne(id: string) {
    const r = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('采购任务不存在');
    const amountYuan = await this.estimatedAmountYuan(id);
    return {
      ...this.serialize(r),
      estimatedAmountWan: toWan(amountYuan),
      stages: this.buildStages(r),
    };
  }

  /** 新建任务：自动编号，状态「未发起」，stage=0 */
  async create(
    data: { type?: string; content?: string; purpose?: string; preMeetingRequired?: boolean; procurementCategory?: string },
    projectId: string,
  ) {
    if (!isTaskType(data?.type)) throw new BadRequestException('请选择采购类型（引用框架协议/单项采购）');
    const content = String(data?.content ?? '').trim();
    if (!content) throw new BadRequestException('请填写采购内容');
    const purpose = data?.purpose != null ? String(data.purpose).trim() : '';
    const preMeetingRequired = data?.preMeetingRequired === true;
    const procurementCategory = data?.procurementCategory != null ? String(data.procurementCategory).trim() || null : null;

    const taskNo = await this.nextTaskNo(projectId);
    const created = await this.prisma.procurementTask.create({
      data: {
        projectId, taskNo, type: data.type as TaskType,
        content, purpose: purpose || null,
        status: STATUS_NOT_STARTED, stage: 0, preMeetingRequired,
        procurementCategory,
      },
    });
    return this.serialize(created);
  }

  /**
   * 编辑基本信息（采购内容/用途）。
   * 约束：进入合同阶段前且当前阶段为总清单之前（未发起/总清单编制中）才允许修改，
   * 避免清单/公告等已按内容发布后再变更造成不一致。
   */
  async update(
    id: string,
    data: {
      content?: string;
      purpose?: string;
      preMeetingRequired?: boolean;
      procurementCategory?: string;
      techQuality?: string;
      acceptanceMethod?: string;
      paymentMethod?: string;
    },
  ) {
    const current = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购任务不存在');
    const editableStatuses = [STATUS_NOT_STARTED, 'LIST_EDITING'];
    if (!editableStatuses.includes(current.status)) {
      throw new BadRequestException('任务已进入后续流程，基本信息不可修改');
    }
    const patch: {
      content?: string;
      purpose?: string | null;
      preMeetingRequired?: boolean;
      procurementCategory?: string | null;
      techQuality?: string | null;
      acceptanceMethod?: string | null;
      paymentMethod?: string | null;
    } = {};
    if (data?.content != null) {
      const c = String(data.content).trim();
      if (!c) throw new BadRequestException('采购内容不能为空');
      patch.content = c;
    }
    if (data?.purpose != null) patch.purpose = String(data.purpose).trim() || null;
    if (data?.procurementCategory != null) {
      patch.procurementCategory = String(data.procurementCategory).trim() || null;
    }
    if (data?.techQuality != null) patch.techQuality = String(data.techQuality) || null;
    if (data?.acceptanceMethod != null) patch.acceptanceMethod = String(data.acceptanceMethod) || null;
    if (data?.paymentMethod != null) patch.paymentMethod = String(data.paymentMethod) || null;
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
  async publish(id: string, user?: any) {
    const current = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购任务不存在');

    // 任务 3.2：发布总采购清单（阶段 0 → 1）时，按预计采购金额自动判定是否需要采前会会议纪要。
    // 规则：仅「单项采购」类型；预计采购金额 ≥ 100 万元 → 生成该模块，< 100 万不生成。
    let preMeetingRequired = current.preMeetingRequired;
    if (current.stage === 0 && current.type === 'SINGLE') {
      const amountYuan = await this.estimatedAmountYuan(current.id);
      preMeetingRequired = amountYuan >= PRE_MEETING_THRESHOLD_YUAN;
    }

    const chain = stageChain(current.type, preMeetingRequired);
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
    // 任务 3.2：发布「采前会会议纪要」前必须已保存内容（会议时间与采购内容为必填）
    if (current.stage === 1 && current.type === 'SINGLE' && preMeetingRequired) {
      const minutes = await this.prisma.preMeetingMinutes.findUnique({ where: { taskId: current.id } });
      if (!minutes?.meetingTime || !String(minutes.content ?? '').trim()) {
        throw new BadRequestException('请先编辑并保存采前会会议纪要（至少填写会议时间与采购内容）后再发布');
      }
    }
    // 任务 3.3：发布「采购公告」前必须已保存内容（采购编号、采购时间与采购内容为必填）
    const noticeIndex = current.type === 'SINGLE' ? noticeStageIndex(current) : -1;
    if (noticeIndex >= 0 && current.stage === noticeIndex) {
      const notice = await this.prisma.procurementNotice.findUnique({ where: { taskId: current.id } });
      if (
        !String(notice?.procurementNo ?? '').trim() ||
        !notice?.procurementTime ||
        !String(notice?.content ?? '').trim()
      ) {
        throw new BadRequestException(
          '请先编辑并保存采购公告（至少填写采购编号、采购时间与采购内容）后再发布',
        );
      }
    }
    // 任务 3.4：发布「采购文件」前必须已保存内容（采购时间与响应保证金为必填）
    const documentIndex = current.type === 'SINGLE' ? documentStageIndex(current) : -1;
    if (documentIndex >= 0 && current.stage === documentIndex) {
      const doc = await this.prisma.procurementDocument.findUnique({ where: { taskId: current.id } });
      if (!doc?.procurementTime || doc?.responseDeposit == null) {
        throw new BadRequestException(
          '请先编辑并保存采购文件（至少填写采购时间与响应保证金）后再发布',
        );
      }
    }
    // 任务 3.5：发布「成交报告」前必须已保存内容（采购开启时间必填，且已导入响应单位明细）
    const reportIndex = current.type === 'SINGLE' ? resultReportStageIndex(current) : -1;
    if (reportIndex >= 0 && current.stage === reportIndex) {
      const report = await this.prisma.procurementResultReport.findUnique({
        where: { taskId: current.id },
      });
      if (!report?.openTime) {
        throw new BadRequestException('请先编辑并保存成交报告（至少填写采购开启时间）后再发布');
      }
      const supplierCount = this.parseJsonArray(report.suppliers).length;
      if (supplierCount === 0) {
        throw new BadRequestException(
          '请先导入「响应单位情况汇总表」（至少一条响应单位）后再发布',
        );
      }
    }
    // 任务 3.6：发布「采购价格对比表」前必须已保存内容（计价方式与采购效益分析说明为必填）
    const priceIndex = current.type === 'SINGLE' ? priceCompareStageIndex(current) : -1;
    if (priceIndex >= 0 && current.stage === priceIndex) {
      const pc = await this.prisma.procurementPriceCompare.findUnique({
        where: { taskId: current.id },
      });
      if (!String(pc?.pricingMethod ?? '').trim() || !String(pc?.benefitAnalysis ?? '').trim()) {
        throw new BadRequestException(
          '请先编辑并保存采购价格对比表（至少填写计价方式与采购效益分析说明）后再发布',
        );
      }
    }

    const nextStage = current.stage + 1;
    const nextStatus = this.deriveStatus(current.type, preMeetingRequired, nextStage, current.contractId);
    const updated = await this.prisma.procurementTask.update({
      where: { id },
      data: {
        stage: nextStage,
        status: nextStatus,
        // 采前会要求随预计采购金额自动落库（仅单项采购在总清单发布时判定）
        ...(preMeetingRequired !== current.preMeetingRequired ? { preMeetingRequired } : {}),
        version: { increment: 1 },
      },
    });
    // 补充一：全部阶段发布完毕（单项采购=采购价格对比表 / 引用框架协议=框架协议事前说明）后，
    // 自动在「合同起草」生成关联合同（草稿）并回写 task.contractId。
    if (nextStage >= chain.length && !current.contractId) {
      try {
        const linked = await this.generateLinkedContract(current, current.projectId, user);
        if (linked) {
          await this.prisma.procurementTask.update({
            where: { id },
            data: { contractId: linked.id, version: { increment: 1 } },
          });
        }
      } catch (err) {
        // 自动生成失败不阻断任务发布流转（合同可由用户在起草页手动新建）
        console.error('[采购任务] 自动生成关联合同失败：', err);
      }
    }
    // 事前说明阶段发布 → 回填发布时间（状态由 stage 推导：已发布即「已完成」）
    if (current.stage === 1 && current.type === 'FRAMEWORK') {
      await this.prisma.frameworkExplanation.updateMany({
        where: { taskId: id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
    // 采前会阶段发布 → 回填发布时间
    if (current.stage === 1 && current.type === 'SINGLE' && preMeetingRequired) {
      await this.prisma.preMeetingMinutes.updateMany({
        where: { taskId: id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
    // 任务 3.3：采购公告阶段发布 → 回填发布时间（状态 编辑中 → 已完成）
    if (noticeIndex >= 0 && current.stage === noticeIndex) {
      await this.prisma.procurementNotice.updateMany({
        where: { taskId: id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
    // 任务 3.4：采购文件阶段发布 → 回填发布时间（状态 编辑中 → 已完成）
    if (documentIndex >= 0 && current.stage === documentIndex) {
      await this.prisma.procurementDocument.updateMany({
        where: { taskId: id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
    // 任务 3.5：成交报告阶段发布 → 回填发布时间（状态 编辑中 → 已完成）
    if (reportIndex >= 0 && current.stage === reportIndex) {
      await this.prisma.procurementResultReport.updateMany({
        where: { taskId: id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
    // 任务 3.6：采购价格对比表阶段发布 → 回填发布时间（状态 编辑中 → 已完成）
    if (priceIndex >= 0 && current.stage === priceIndex) {
      await this.prisma.procurementPriceCompare.updateMany({
        where: { taskId: id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
    return { ...this.serialize(updated), stages: this.buildStages(updated) };
  }

  /**
   * 补充一/补充三/补充四：按「采购类型 + 采购品类」解析关联合同类型与合同模板。
   * 映射（补充三修正）：
   * - 单项采购 + 物资 → 采购合同（PURCHASE）
   * - 单项采购 + 租赁 → 租赁合同（LEASE）
   * - 引用框架协议 + 物资 → 采购执行合同（PURCHASE_EXEC）
   * - 引用框架协议 + 租赁 → 租赁执行合同（LEASE_EXEC）
   * 合同模板匹配：按合同类型字典项名称关键字匹配 ContractTemplate（执行类优先含「执行」，非执行类排除「执行」）。
   * 采购品类缺失或不匹配时返回 null。
   */
  private async resolveContractTemplate(type: string, category?: string | null) {
    const typeCodeByKey: Record<string, string> = {
      'SINGLE|物资': 'PURCHASE',
      'SINGLE|租赁': 'LEASE',
      'FRAMEWORK|物资': 'PURCHASE_EXEC',
      'FRAMEWORK|租赁': 'LEASE_EXEC',
    };
    const typeCode = typeCodeByKey[`${type}|${category ?? ''}`];
    if (!typeCode) return null;
    const typeNameByCode: Record<string, string> = {
      PURCHASE: '采购合同',
      LEASE: '租赁合同',
      PURCHASE_EXEC: '采购执行合同',
      LEASE_EXEC: '租赁执行合同',
    };
    const typeName = typeNameByCode[typeCode] ?? typeCode;
    const templates = await this.prisma.contractTemplate.findMany({
      where: { name: { contains: typeName }, status: 1 },
      orderBy: { createdAt: 'asc' },
    });
    const wantExec = typeCode.endsWith('_EXEC');
    const matched = templates.filter((t) => (wantExec ? t.name.includes('执行') : !t.name.includes('执行')));
    const template = matched[0] ?? templates[0] ?? null;
    return { typeCode, typeName, templateId: template?.id ?? null, templateName: template?.name ?? null };
  }

  /**
   * 补充一：采购任务全部阶段发布完毕（单项采购=采购价格对比表 / 引用框架协议=框架协议事前说明）后，
   * 按「采购类型 + 采购品类」映射对应合同类型与合同模板，自动生成草稿合同并关联到本任务。
   * 合同草稿预填：合同类型 / 是否框架 / 关联模板 / 合同金额（总清单预计采购合价）/ 技术质量·验收·付款标准（补充二）。
   */
  private async generateLinkedContract(task: TaskRow, projectId: string, user?: any) {
    const resolved = await this.resolveContractTemplate(task.type, task.procurementCategory);
    if (!resolved) return null; // 采购品类缺失或不匹配，跳过自动生成

    // 合同编号（按类型与项目生成；段缺失不阻断）
    const { code } = await this.contractService.nextCode({ typeCode: resolved.typeCode, projectId });
    if (!code) return null;

    return this.contractService.create(
      {
        code,
        typeCode: resolved.typeCode,
        isFramework: task.type === 'FRAMEWORK' ? 'Y' : 'N',
        templateId: resolved.templateId,
        status: 'DRAFT',
        autoName: true,
        materialDescription: task.content,
        // 补充二：技术质量/验收/付款标准随合同起草一并带入模板数据
        formData: JSON.stringify({
          技术质量标准: task.techQuality ?? '',
          验收方式: task.acceptanceMethod ?? '',
          付款方式: task.paymentMethod ?? '',
        }),
      },
      projectId,
      user,
    );
  }

  /**
   * 补充四：采购文件「导出合同模板 / 预览合同模板」数据来源。
   * 返回与任务「采购类型 + 采购品类」匹配的合同模板内容，以及采购发起填写的技术质量/验收/付款标准，
   * 供前端注入模板占位符并生成 Word。
   */
  async contractTemplate(taskId: string) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    const resolved = await this.resolveContractTemplate(task.type, task.procurementCategory);
    const tpl = resolved?.templateId
      ? await this.prisma.contractTemplate.findUnique({ where: { id: resolved.templateId } })
      : null;
    return {
      task: this.serialize(task),
      typeCode: resolved?.typeCode ?? null,
      templateId: resolved?.templateId ?? null,
      templateName: resolved?.templateName ?? null,
      content: tpl?.content ?? '',
      techQuality: task.techQuality ?? '',
      acceptanceMethod: task.acceptanceMethod ?? '',
      paymentMethod: task.paymentMethod ?? '',
    };
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

    const num = numOf('数量/单价');

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

    // 需求修正（修改一 · 2.2）：判断时机 = 总采购清单保存后。
    // 系统自动计算「预计采购合价」合计（Σ 预计采购单价 × 暂定数量），
    // 单项采购且合计 ≥ 100 万元 → 生成采前会会议纪要模块；引用框架协议或合计 < 100 万 → 不生成。
    let preMeetingRequired = task.preMeetingRequired;
    if (task.type === 'SINGLE' && task.stage === 0) {
      const amountYuan = await this.estimatedAmountYuan(taskId);
      preMeetingRequired = amountYuan >= PRE_MEETING_THRESHOLD_YUAN;
      if (preMeetingRequired !== task.preMeetingRequired) {
        await this.prisma.procurementTask.update({
          where: { id: taskId },
          data: { preMeetingRequired },
        });
      }
    }

    const list = await this.totalList(taskId);
    const amountYuan = await this.estimatedAmountYuan(taskId);
    return {
      ...list,
      estimatedAmountYuan: Math.round(amountYuan * 100) / 100,
      estimatedAmountWan: toWan(amountYuan),
      preMeetingRequired,
    };
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
   * 预计采购金额（元）= Σ 预计采购单价（控制价）× 暂定数量。
   * 任务 3.2：作为「是否需要采前会会议纪要」的判定依据（阈值 100 万元）。
   */
  private async estimatedAmountYuan(taskId: string): Promise<number> {
    const items = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      select: { qty: true, planPrice: true },
    });
    return items.reduce((sum, i) => sum + (i.planPrice ?? 0) * (i.qty ?? 0), 0);
  }

  /** 批量计算预计采购金额（元），key = taskId（列表页避免 N+1 查询） */
  private async estimatedAmountMap(taskIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!taskIds.length) return map;
    const items = await this.prisma.procurementTotalItem.findMany({
      where: { taskId: { in: taskIds } },
      select: { taskId: true, qty: true, planPrice: true },
    });
    for (const it of items) {
      map.set(it.taskId, (map.get(it.taskId) ?? 0) + (it.planPrice ?? 0) * (it.qty ?? 0));
    }
    return map;
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

  /** 模块记录 → 阶段链 key 与 Prisma 模型（问题二：子模块删除 + 流程回退） */
  private static readonly MODULE_DELETE_MODELS: Record<string, { stageKey: string; model: string }> = {
    FRAMEWORK_EXPLANATION: { stageKey: 'FRAMEWORK_EXPLAIN', model: 'frameworkExplanation' },
    PRE_MEETING: { stageKey: 'PRE_MEETING', model: 'preMeetingMinutes' },
    NOTICE: { stageKey: 'NOTICE', model: 'procurementNotice' },
    DOCUMENT: { stageKey: 'DOCUMENT', model: 'procurementDocument' },
    RESULT_REPORT: { stageKey: 'RESULT_REPORT', model: 'procurementResultReport' },
    PRICE_COMPARE: { stageKey: 'PRICE_COMPARE', model: 'procurementPriceCompare' },
  };

  /**
   * 删除子模块记录并回退流程（问题二）：
   * - 仅允许删除流程最末端的模块（其后的阶段已有记录/已发布时须先删后面的，防止流程链断裂）；
   * - 删除后 task.stage 回退到该模块阶段、状态回退为该模块「编制中」，上一阶段恢复可编辑；
   * - 已进入合同阶段的任务不可删除任何模块。
   */
  async deleteModule(id: string, moduleKey: string) {
    const def = ProcurementTaskService.MODULE_DELETE_MODELS[String(moduleKey ?? '')];
    if (!def) throw new BadRequestException('无效的模块标识');

    const current = await this.prisma.procurementTask.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购任务不存在');
    const chain = stageChain(current.type, current.preMeetingRequired);
    if (current.stage >= chain.length) {
      throw new BadRequestException('任务已进入合同阶段，不可删除模块');
    }
    const moduleIndex = chain.findIndex((s) => s.key === def.stageKey);
    if (moduleIndex < 0) {
      throw new BadRequestException('该采购任务不包含此模块');
    }
    if (current.stage > moduleIndex + 1) {
      throw new BadRequestException('后续阶段已编制/发布，请先删除后面的阶段模块');
    }

    const record = await (this.prisma as any)[def.model].findUnique({ where: { taskId: id } });
    if (!record) throw new NotFoundException('该模块尚未填写内容');

    const wasPublished = current.stage === moduleIndex + 1;
    await (this.prisma as any)[def.model].delete({ where: { id: record.id } });
    const updated = await this.prisma.procurementTask.update({
      where: { id },
      data: { stage: moduleIndex, status: chain[moduleIndex].status, version: { increment: 1 } },
    });
    return {
      ...this.serialize(updated),
      stages: this.buildStages(updated),
      wasPublished,
      message: wasPublished ? '已删除该模块并回退流程，上一阶段恢复可编辑' : '已清除该模块草稿',
    };
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

    const text = textOf;
    const num = numOf('表格中的价格/占比');
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
      // 问题五：引用供应商及金额 [{supplier, amount}]（可从询价情况表自动填充最低价单位）
      referenceSuppliers: rows(body?.referenceSuppliers, ['supplier', 'amount']),
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

  /**
   * 采前会会议纪要（批次二 · 任务 3.2，仅「单项采购」且预计采购金额 ≥ 100 万）。
   * 状态由阶段进度推导：stage=1 编辑中（仅保存），stage≥2 已完成（发布后，仍可重新编辑）。
   */
  async preMeetingMinutes(taskId: string) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采前会会议纪要模块');
    }
    const amountYuan = await this.estimatedAmountYuan(taskId);
    // 生成条件：单项采购且预计采购金额 ≥ 100 万元（存量手工标记同样视为需要）
    const generated = task.preMeetingRequired || amountYuan >= PRE_MEETING_THRESHOLD_YUAN;
    const record = await this.prisma.preMeetingMinutes.findUnique({ where: { taskId } });
    const published = task.stage >= 2;
    // 补充二：采前会纪要的「技术质量标准 / 验收方式 / 付款方式」默认取自采购发起填写的任务三字段；
    // 纪要自身已填写则优先（自身覆盖任务）。
    const minutesData = record ? this.serializeMinutes(record) : null;
    if (minutesData) {
      minutesData.techQuality = minutesData.techQuality || task.techQuality || '';
      minutesData.acceptance = minutesData.acceptance || task.acceptanceMethod || '';
      minutesData.paymentTerms = minutesData.paymentTerms || task.paymentMethod || '';
    }
    return {
      task: this.serialize(task),
      /** 是否生成采前会会议纪要模块（单项采购且金额 ≥ 100 万） */
      generated,
      thresholdWan: PRE_MEETING_THRESHOLD_YUAN / 10000,
      estimatedAmountWan: toWan(amountYuan),
      editable: task.stage >= 1 && !published,
      published,
      status: published ? 'COMPLETED' : 'EDITING',
      statusLabel: published ? '已完成' : '编辑中',
      data: minutesData,
    };
  }

  /** 保存采前会会议纪要（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async savePreMeetingMinutes(taskId: string, body: any) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采前会会议纪要模块');
    }
    if (task.stage < 1) {
      throw new BadRequestException('总采购清单发布后才能编辑采前会会议纪要');
    }
    const amountYuan = await this.estimatedAmountYuan(taskId);
    if (!task.preMeetingRequired && amountYuan < PRE_MEETING_THRESHOLD_YUAN) {
      throw new BadRequestException(
        `预计采购金额不足 ${PRE_MEETING_THRESHOLD_YUAN / 10000} 万元，无需编制采前会会议纪要`,
      );
    }

    const text = textOf;
    const num = numOf('表格中的数量/金额');
    const date = dateOf('会议时间');
    /** 表格行：数值字段按数字存，其余按文本存；空表存 null */
    const jsonRows = (v: any, numericFields: string[], fields: string[]): string | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException('表格数据无效');
      const numeric = new Set(numericFields);
      const normalized = v
        .filter((r: any) => r != null && typeof r === 'object')
        .map((r: any) => {
          const row: Record<string, string | number | null> = {};
          for (const f of fields) row[f] = numeric.has(f) ? num(r?.[f]) : text(r?.[f]);
          return row;
        });
      return normalized.length ? JSON.stringify(normalized) : null;
    };
    /** 询价单图片（支持多张） */
    const images = (v: any): string | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException('询价单图片数据无效');
      const normalized = v
        .filter((f: any) => f?.url)
        .map((f: any) => ({ fileName: text(f.fileName) ?? '询价单', url: String(f.url), size: num(f.size) }));
      return normalized.length ? JSON.stringify(normalized) : null;
    };

    const payload = {
      meetingTime: date(body?.meetingTime),
      content: text(body?.content),
      host: text(body?.host),
      attendees: text(body?.attendees),
      writer: text(body?.writer),
      reviewer: text(body?.reviewer),
      purchaseItems: jsonRows(body?.purchaseItems, ['qty'], ['materialName', 'spec', 'unit', 'qty']),
      techQuality: text(body?.techQuality),
      acceptance: text(body?.acceptance),
      paymentTerms: text(body?.paymentTerms),
      // 成本分析表：income/cost 均为「万元」，效益额与效益率由前端按公式计算展示
      costRows: jsonRows(body?.costRows, ['income', 'cost'], ['materialName', 'spec', 'income', 'cost']),
      inquirySheets: images(body?.inquirySheets),
    };

    const saved = await this.prisma.preMeetingMinutes.upsert({
      where: { taskId },
      create: { ...payload, projectId: task.projectId, taskId },
      update: payload,
    });
    return this.serializeMinutes(saved);
  }

  private serializeMinutes(r: {
    id: string;
    taskId: string;
    meetingTime: Date | null;
    content: string | null;
    host: string | null;
    attendees: string | null;
    writer: string | null;
    reviewer: string | null;
    purchaseItems: string | null;
    techQuality: string | null;
    acceptance: string | null;
    paymentTerms: string | null;
    costRows: string | null;
    inquirySheets: string | null;
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
      meetingTime: r.meetingTime,
      content: r.content ?? '',
      host: r.host ?? '',
      attendees: r.attendees ?? '',
      writer: r.writer ?? '',
      reviewer: r.reviewer ?? '',
      purchaseItems: parse(r.purchaseItems),
      techQuality: r.techQuality ?? '',
      acceptance: r.acceptance ?? '',
      paymentTerms: r.paymentTerms ?? '',
      costRows: parse(r.costRows),
      inquirySheets: parse(r.inquirySheets),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  /**
   * 采购公告（批次二 · 任务 3.3，仅「单项采购」任务）。
   * 状态由阶段进度推导：stage=公告阶段下标 → 编辑中；stage > 公告阶段下标 → 已完成（发布后，仍可重新编辑）。
   * 采购清单不落库，始终从「总采购清单」派生（数据来自总采购清单、不可编辑）。
   */
  async notice(taskId: string) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购公告模块');
    }
    const stageIndex = noticeStageIndex(task);
    const reached = task.stage >= stageIndex;
    const published = task.stage > stageIndex;
    const record = await this.prisma.procurementNotice.findUnique({ where: { taskId } });
    const items = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      task: this.serialize(task),
      /** 公告阶段在阶段链中的下标（单项采购：无采前会=1 / 有采前会=2） */
      stageIndex,
      /** 是否已进入或完成公告阶段（总清单、采前会已发布） */
      reached,
      editable: reached && !published,
      published,
      status: published ? 'COMPLETED' : 'EDITING',
      statusLabel: published ? '已完成' : '编辑中',
      /** 采购清单（只读）：来自总采购清单 */
      purchaseItems: items.map((i) => ({
        materialName: i.materialName,
        spec: i.spec,
        unit: i.unit,
        qty: i.qty,
        remark: '',
      })),
      data: record ? this.serializeNotice(record) : null,
    };
  }

  /** 保存采购公告（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async saveNotice(taskId: string, body: any) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购公告模块');
    }
    if (task.stage < noticeStageIndex(task)) {
      throw new BadRequestException('请先发布总采购清单（如有采前会会议纪要亦需发布）后再编制采购公告');
    }

    const text = textOf;
    const date = dateOf('采购时间');
    /** 动态列表（联系人 / 联系电话）：按位置保存，仅裁剪尾部空项以保证「联系人N/联系电话N」按同一位置配对 */
    const list = (v: any, label: string): string | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException(`${label}数据无效`);
      const arr = v.map((x: any) => String(x ?? '').trim());
      while (arr.length && !arr[arr.length - 1]) arr.pop();
      return arr.length ? JSON.stringify(arr) : null;
    };

    const payload = {
      procurementNo: text(body?.procurementNo),
      procurementTime: date(body?.procurementTime),
      content: text(body?.content),
      contacts: list(body?.contacts, '联系人'),
      contactPhones: list(body?.contactPhones, '联系电话'),
    };

    const saved = await this.prisma.procurementNotice.upsert({
      where: { taskId },
      create: { ...payload, projectId: task.projectId, taskId },
      update: payload,
    });
    return this.serializeNotice(saved);
  }

  private serializeNotice(r: {
    id: string;
    taskId: string;
    procurementNo: string | null;
    procurementTime: Date | null;
    content: string | null;
    techQuality: string | null;
    acceptanceMethod: string | null;
    paymentMethod: string | null;
    contacts: string | null;
    contactPhones: string | null;
    publishedAt: Date | null;
    updatedAt: Date;
  }) {
    const parseList = (s: string | null): string[] => {
      if (!s) return [];
      try {
        const arr = JSON.parse(s);
        return Array.isArray(arr) ? arr.map((x) => String(x ?? '')) : [];
      } catch {
        return [];
      }
    };
    return {
      id: r.id,
      taskId: r.taskId,
      procurementNo: r.procurementNo ?? '',
      procurementTime: r.procurementTime,
      content: r.content ?? '',
      techQuality: r.techQuality ?? '',
      acceptanceMethod: r.acceptanceMethod ?? '',
      paymentMethod: r.paymentMethod ?? '',
      contacts: parseList(r.contacts),
      contactPhones: parseList(r.contactPhones),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  /**
   * 采购文件（批次二 · 任务 3.4，仅「单项采购」任务）。
   * 入口条件：采购公告已完成（stage > 采购公告阶段下标）；本阶段编辑中 ⇔ stage === 采购文件下标。
   * 采购清单不落库，始终从「总采购清单」派生：
   * 物资名称/规格型号/计量单位/暂定数量/备注来自总清单，
   * 税前单价/税率/综合单价/合价恒为空（由投标方填写）。
   */
  async document(taskId: string) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购文件模块');
    }
    const noticeIndex = noticeStageIndex(task);
    const stageIndex = documentStageIndex(task);
    /** 采购公告已完成后本阶段即进入（reached）；本阶段发布后为已完成 */
    const reached = task.stage >= stageIndex;
    const published = task.stage > stageIndex;
    const record = await this.prisma.procurementDocument.findUnique({ where: { taskId } });
    const notice = await this.prisma.procurementNotice.findUnique({ where: { taskId } });
    const items = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      task: this.serialize(task),
      stageIndex,
      noticeStageIndex: noticeIndex,
      /** 采购公告是否已完成（采购文件的入口条件） */
      noticeCompleted: task.stage > noticeIndex,
      reached,
      editable: reached && !published,
      published,
      status: published ? 'COMPLETED' : 'EDITING',
      statusLabel: published ? '已完成' : '编辑中',
      /** 来自采购公告的取值（采购编号/采购内容来自公告；技术质量标准/验收方式/付款方式来自采购发起 task） */
      notice: notice
        ? {
            procurementNo: notice.procurementNo ?? '',
            content: notice.content ?? '',
            techQuality: task.techQuality ?? '',
            acceptanceMethod: task.acceptanceMethod ?? '',
            paymentMethod: task.paymentMethod ?? '',
          }
        : null,
      /**
       * 采购清单（只读，来自总采购清单）：10 列。
       * 价格类字段恒为 null，保证「价格留空、由投标方填写」。
       */
      purchaseItems: items.map((i) => ({
        materialName: i.materialName,
        spec: i.spec,
        unit: i.unit,
        qty: i.qty,
        preTaxPrice: null,
        taxRate: null,
        unitPrice: null,
        amount: null,
        remark: '',
      })),
      data: record ? this.serializeDocument(record) : null,
    };
  }

  /** 保存采购文件（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async saveDocument(taskId: string, body: any) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购文件模块');
    }
    if (task.stage < documentStageIndex(task)) {
      throw new BadRequestException('请先发布采购公告（采购公告已完成）后再编制采购文件');
    }

    const text = textOf;
    const num = numOf('响应保证金', { min: 0 });
    const date = dateOf('采购时间');

    const payload = {
      procurementTime: date(body?.procurementTime),
      responseDeposit: num(body?.responseDeposit),
      quoteDescription: text(body?.quoteDescription),
    };

    const saved = await this.prisma.procurementDocument.upsert({
      where: { taskId },
      create: { ...payload, projectId: task.projectId, taskId },
      update: payload,
    });
    return this.serializeDocument(saved);
  }

  private serializeDocument(r: {
    id: string;
    taskId: string;
    procurementTime: Date | null;
    responseDeposit: number | null;
    quoteDescription: string | null;
    publishedAt: Date | null;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      taskId: r.taskId,
      procurementTime: r.procurementTime,
      responseDeposit: r.responseDeposit,
      quoteDescription: r.quoteDescription ?? '',
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  /**
   * 成交报告（批次二 · 任务 3.5，仅「单项采购」任务）。
   * 入口条件：采购文件已完成（stage > 采购文件阶段下标）；本阶段编辑中 ⇔ stage === 成交报告下标。
   * 四张表（响应单位情况汇总表 / 开启报价情况表 / 第二轮报价情况表 / 拟推荐成交候选人表）
   * 由 suppliers（导入明细）与 candidates（勾选）派生，不单独落库；
   * 「预计采购金额」来自总采购清单（Σ 控制价 × 暂定数量）。
   */
  async resultReport(taskId: string) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用成交报告模块');
    }
    const documentIndex = documentStageIndex(task);
    const stageIndex = resultReportStageIndex(task);
    const reached = task.stage >= stageIndex;
    const published = task.stage > stageIndex;
    const record = await this.prisma.procurementResultReport.findUnique({ where: { taskId } });
    const doc = await this.prisma.procurementDocument.findUnique({ where: { taskId } });
    const notice = await this.prisma.procurementNotice.findUnique({ where: { taskId } });
    const estimatedYuan = await this.estimatedAmountYuan(taskId);
    return {
      task: this.serialize(task),
      stageIndex,
      documentStageIndex: documentIndex,
      /** 采购文件是否已完成（成交报告的入口条件） */
      documentCompleted: task.stage > documentIndex,
      reached,
      editable: reached && !published,
      published,
      status: published ? 'COMPLETED' : 'EDITING',
      statusLabel: published ? '已完成' : '编辑中',
      /** 采购内容（默认取采购公告内容，其次取采购任务内容） */
      content: notice?.content ?? task.content ?? '',
      /** 预计采购金额（元，来自总采购清单） */
      estimatedAmount: estimatedYuan,
      /** 采购文件（响应保证金等，供页面参考展示） */
      document: doc ? this.serializeDocument(doc) : null,
      /** 响应单位明细（导入），四张表由其派生 */
      suppliers: this.parseJsonArray<Record<string, any>>(record?.suppliers),
      /** 拟推荐成交候选人（第二轮报价表勾选） */
      candidates: this.parseJsonArray<Record<string, any>>(record?.candidates),
      data: record ? this.serializeResultReport(record) : null,
    };
  }

  /** 保存成交报告（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async saveResultReport(taskId: string, body: any) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用成交报告模块');
    }
    if (task.stage < resultReportStageIndex(task)) {
      throw new BadRequestException('请先发布采购文件（采购文件已完成）后再编制成交报告');
    }

    const text = textOf;
    const int = (v: any, label: string): number | null => intOf(label, { min: 0 })(v);
    const date = dateOf('采购开启时间');
    const suppliers = Array.isArray(body?.suppliers) ? body.suppliers : undefined;
    const candidates = Array.isArray(body?.candidates) ? body.candidates : undefined;

    const payload = {
      unitCount: int(body?.unitCount, '成交单位数量'),
      openTime: date(body?.openTime),
      openPlace: text(body?.openPlace),
      reviewMembers: text(body?.reviewMembers),
      approvedCount: int(body?.approvedCount, '审核通过响应单位数量'),
      participantCount: int(body?.participantCount, '参与响应单位数量'),
      abstainCount: int(body?.abstainCount, '弃权响应单位数量'),
      validFileCount: int(body?.validFileCount, '有效响应文件数量'),
      ...(suppliers !== undefined ? { suppliers: JSON.stringify(suppliers) } : {}),
      ...(candidates !== undefined ? { candidates: JSON.stringify(candidates) } : {}),
    };

    const saved = await this.prisma.procurementResultReport.upsert({
      where: { taskId },
      create: { ...payload, projectId: task.projectId, taskId },
      update: payload,
    });
    return this.serializeResultReport(saved);
  }

  /**
   * 导入「响应单位情况汇总表」（Excel）。
   * 解析后覆盖式写入响应单位明细，四张表随之自动重建。
   */
  async importResultReport(taskId: string, buffer?: Buffer) {
    if (!buffer) throw new BadRequestException('未上传文件');
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用成交报告模块');
    }
    if (task.stage < resultReportStageIndex(task)) {
      throw new BadRequestException('请先发布采购文件（采购文件已完成）后再导入响应单位情况汇总表');
    }

    // 解析表头（第 1 行）之后的所有行。不再按行号硬性跳过第 2 行示例行，
    // 否则用户在示例行直接填写真实数据（高频用法）时该行会被丢弃，表现为「第二行导入失败」。
    const rawRows = await this.excel.parse(buffer, []);
    if (!rawRows.length)
      throw new BadRequestException('导入文件无有效数据行（请从第 3 行起填写，或直接在示例行填入真实数据）');

    const str = (v: any): string => String(v ?? '').trim();

    // 识别并跳过模板自带的示例行（第 2 行）：仅当其字段与模板示例完全一致时才视为示例行；
    // 用户若在示例行填入真实数据，则视为数据行，从而避免漏导。
    const isExampleRow = (r: any): boolean =>
      str(r['参与响应单位名称']) === '某某建材有限公司' &&
      num(r['第一轮报价不含税总额']) === 985000 &&
      num(r['第一轮报价税金']) === 128050 &&
      num(r['第二轮报价不含税总额']) === 960000 &&
      num(r['第二轮报价税金']) === 124800;

    const rows = rawRows.filter((r) => !isExampleRow(r));
    if (!rows.length)
      throw new BadRequestException('导入文件无有效数据行（识别到的行均为模板示例行，请填写真实数据）');

    const suppliers = rows.map((r, i) => ({
      seq: num(r['序号']) ?? i + 1,
      name: str(r['参与响应单位名称']),
      depositPaid: str(r['响应保证金是否缴纳']),
      sealed: str(r['响应文件密封是否完整']),
      passedFirst: str(r['是否通过第一轮报价']),
      firstPreTaxTotal: num(r['第一轮报价不含税总额']),
      firstTax: num(r['第一轮报价税金']),
      secondPreTaxTotal: num(r['第二轮报价不含税总额']),
      secondTax: num(r['第二轮报价税金']),
      remark: str(r['备注']),
    }));
    const invalid = suppliers.filter((s) => !s.name);
    if (invalid.length) {
      throw new BadRequestException(
        `导入校验失败：第 ${invalid.map((s) => s.seq).join('、')} 行缺少「参与响应单位名称」`,
      );
    }

    const saved = await this.prisma.procurementResultReport.upsert({
      where: { taskId },
      create: { projectId: task.projectId, taskId, suppliers: JSON.stringify(suppliers) },
      update: { suppliers: JSON.stringify(suppliers) },
    });
    return {
      imported: suppliers.length,
      created: suppliers.length,
      ...this.serializeResultReport(saved),
    };
  }

  /** 「响应单位情况汇总表」导入模板（表头与导入解析列名一致） */
  async resultReportTemplate() {
    const yesNo = ['是', '否'];
    const columns: TemplateColumn[] = [
      { label: '序号', key: 'seq', type: 'int', width: 8, example: 1, desc: '可留空，系统按行序自动编号' },
      { label: '参与响应单位名称', key: 'name', required: true, type: 'text', width: 30, example: '某某建材有限公司' },
      { label: '响应保证金是否缴纳', key: 'depositPaid', type: 'select', width: 20, example: '是', options: yesNo },
      { label: '响应文件密封是否完整', key: 'sealed', type: 'select', width: 22, example: '是', options: yesNo },
      {
        label: '是否通过第一轮报价',
        key: 'passedFirst',
        type: 'select',
        width: 20,
        example: '是',
        options: yesNo,
        desc: '为「否」的单位不参与第二轮报价情况表',
      },
      {
        label: '第一轮报价不含税总额',
        key: 'firstPreTaxTotal',
        type: 'money',
        width: 22,
        example: 985000,
        desc: '单位：元；开启报价情况表按此列由小到大排名',
      },
      { label: '第一轮报价税金', key: 'firstTax', type: 'money', width: 18, example: 128050 },
      {
        label: '第二轮报价不含税总额',
        key: 'secondPreTaxTotal',
        type: 'money',
        width: 22,
        example: 960000,
        desc: '单位：元；第二轮报价情况表按此列由小到大排名',
      },
      { label: '第二轮报价税金', key: 'secondTax', type: 'money', width: 18, example: 124800 },
      { label: '备注', key: 'remark', type: 'text', width: 24, example: '' },
    ];
    return this.tpl.buildTemplate({
      moduleName: '响应单位情况汇总表',
      sheetName: '数据',
      columns,
      extraNotes: [
        '说明：导入后自动生成「响应单位情况汇总表 / 开启报价情况表 / 第二轮报价情况表 / 拟推荐成交候选人表」四张表。',
        '说明：重复导入将覆盖已有的响应单位明细，不影响手工填写的成交报告基本信息。',
      ],
    });
  }

  /**
   * 采购价格对比表（批次二 · 任务 3.6，仅「单项采购」任务）。
   * 入口条件：成交报告已完成（stage > 成交报告阶段下标）；本阶段编辑中 ⇔ stage === 价格对比表下标。
   *
   * 明细表列（共 15 列）：
   * - 序号 / 采购名称 / 规格型号 / 单位 / 数量 / 清单收入不含税单价 / 标准成本不含税单价 /
   *   控制价不含税单价 / 信息价不含税单价 —— 全部来自总采购清单（ProcurementTotalItem），
   *   只读派生、不落库；
   * - 成交价不含税单价 / 备注 —— 用户录入，落库于 items（按 materialBaseId 归位）；
   * - 各价格合价与「采购成本降低率 / 采购成交价下浮率 / 信息价下浮率」由前端计算。
   */
  async priceCompare(taskId: string) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购价格对比表模块');
    }
    const reportIndex = resultReportStageIndex(task);
    const stageIndex = priceCompareStageIndex(task);
    const reached = task.stage >= stageIndex;
    const published = task.stage > stageIndex;
    const record = await this.prisma.procurementPriceCompare.findUnique({ where: { taskId } });
    const notice = await this.prisma.procurementNotice.findUnique({ where: { taskId } });
    const totals = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });

    // 已保存行按 materialBaseId 归位（兼容早期按下标保存的数据）
    const savedRows = this.parseJsonArray<Record<string, any>>(record?.items);
    const savedMap = new Map<string, Record<string, any>>();
    savedRows.forEach((r, i) => {
      const k = String(r?.materialBaseId ?? '');
      if (k) savedMap.set(k, r);
      else if (totals[i]) savedMap.set(totals[i].id, r);
    });

    // 明细行 = 总采购清单派生 + 叠加已保存的「成交价 / 备注」
    const items = totals.map((t) => {
      const saved = savedMap.get(t.id) ?? {};
      return {
        materialBaseId: t.id,
        materialName: t.materialName,
        spec: t.spec,
        unit: t.unit,
        qty: t.qty,
        incomePrice: t.incomePrice,
        stdCost: t.stdCost,
        planPrice: t.planPrice,
        infoPrice: t.infoPrice,
        dealPrice: saved.dealPrice ?? null,
        remark: String(saved.remark ?? ''),
      };
    });

    return {
      task: this.serialize(task),
      stageIndex,
      resultReportStageIndex: reportIndex,
      /** 成交报告是否已完成（价格对比表的入口条件） */
      resultReportCompleted: task.stage > reportIndex,
      reached,
      editable: reached && !published,
      published,
      status: published ? 'COMPLETED' : 'EDITING',
      statusLabel: published ? '已完成' : '编辑中',
      /** 采购内容（默认取采购公告内容，其次取采购任务内容） */
      content: notice?.content ?? task.content ?? '',
      /** 明细表行（派生 + 已保存的成交价/备注） */
      items,
      data: record ? { ...this.serializePriceCompare(record), items } : null,
    };
  }

  /** 保存采购价格对比表（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async savePriceCompare(taskId: string, body: any) {
    const task = await this.prisma.procurementTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购价格对比表模块');
    }
    if (task.stage < priceCompareStageIndex(task)) {
      throw new BadRequestException('请先发布成交报告（成交报告已完成）后再编制采购价格对比表');
    }

    const text = textOf;
    const num = (v: any, label: string): number | null => numOf(label, { min: 0 })(v);

    const method = text(body?.pricingMethod);
    if (method && !['FIXED', 'FLOATING'].includes(method)) {
      throw new BadRequestException('计价方式仅支持「固定价」或「浮动价」');
    }

    // 明细行：仅接受「成交价 / 备注」为用户输入，其余列以总采购清单为准回填，防止前端篡改；
    // 行序与总采购清单保持一致，未提交的行补齐为空白行。
    const totals = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });
    const submitted = new Map<string, any>();
    (Array.isArray(body?.items) ? body.items : []).forEach((r: any) => {
      const k = String(r?.materialBaseId ?? '').trim();
      if (k) submitted.set(k, r);
    });
    const items = totals.map((t) => {
      const r = submitted.get(t.id) ?? {};
      return {
        materialBaseId: t.id,
        materialName: t.materialName,
        spec: t.spec,
        unit: t.unit,
        qty: t.qty,
        incomePrice: t.incomePrice,
        stdCost: t.stdCost,
        planPrice: t.planPrice,
        infoPrice: t.infoPrice,
        dealPrice: num(r?.dealPrice, '成交价不含税单价'),
        remark: String(r?.remark ?? '').trim(),
      };
    });

    const payload = {
      pricingMethod: method,
      benefitAnalysis: text(body?.benefitAnalysis),
      items: JSON.stringify(items),
    };
    const saved = await this.prisma.procurementPriceCompare.upsert({
      where: { taskId },
      create: { ...payload, projectId: task.projectId, taskId },
      update: payload,
    });
    return this.serializePriceCompare(saved);
  }

  private serializePriceCompare(r: {
    id: string;
    taskId: string;
    pricingMethod: string | null;
    benefitAnalysis: string | null;
    items: string | null;
    publishedAt: Date | null;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      taskId: r.taskId,
      pricingMethod: r.pricingMethod ?? '',
      benefitAnalysis: r.benefitAnalysis ?? '',
      items: this.parseJsonArray<Record<string, any>>(r.items),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  private serializeResultReport(r: {
    id: string;
    taskId: string;
    unitCount: number | null;
    openTime: Date | null;
    openPlace: string | null;
    reviewMembers: string | null;
    approvedCount: number | null;
    participantCount: number | null;
    abstainCount: number | null;
    validFileCount: number | null;
    suppliers: string | null;
    candidates: string | null;
    publishedAt: Date | null;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      taskId: r.taskId,
      unitCount: r.unitCount,
      openTime: r.openTime,
      openPlace: r.openPlace ?? '',
      reviewMembers: r.reviewMembers ?? '',
      approvedCount: r.approvedCount,
      participantCount: r.participantCount,
      abstainCount: r.abstainCount,
      validFileCount: r.validFileCount,
      suppliers: this.parseJsonArray(r.suppliers),
      candidates: this.parseJsonArray(r.candidates),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  /** JSON 数组字符串 → 数组（解析失败或非数组返回空数组） */
  private parseJsonArray<T = any>(raw: string | null | undefined): T[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
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
      procurementCategory: r.procurementCategory ?? null,
      techQuality: r.techQuality ?? '',
      acceptanceMethod: r.acceptanceMethod ?? '',
      paymentMethod: r.paymentMethod ?? '',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
