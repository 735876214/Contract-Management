import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '../../common/calc/numeric';
import { localDayKey } from '../../common/calc/time';
import { round2 } from '../../common/calc/money';
import { paginate, buildResult, assertVersion, versionedUpdate } from '../../common/utils/helpers';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService } from '../../common/services/import-template.service';
import { ContractService, deleteContractsByIds } from '../contract';
import { updateMaterialBaseUnit } from '../material';
import {
  STAGE_KEYS,
  TASK_STATUS,
  TASK_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  stageChain,
  stageView,
  contractStageState,
  contractStageTaskStatus,
  moduleStageBranches,
  resolveContractUnits,
  candidatesFromBidders,
  TaskType,
  isTaskType,
  deriveContractType,
  ContractCategory,
} from '../../constants/procurementFlow';
import { CONTRACT_STATUS } from '../../constants/statuses';
import { DictService } from '../dict';
import { resolveClauseSnapshot, CLAUSE_TYPE_LABELS, type ClauseSnapshot } from './clause-snapshot';
import { ProcurementStageFormsService } from './procurement-stage-forms.service';
import {
  numOf,
  toWan,
  taskOf,
  mainContract,
  estimatedAmountYuan,
  estimatedAmountMap,
  resolveSupplierId,
  parseJsonArray,
  serializeTask,
  noticeStageIndex,
  documentStageIndex,
  resultReportStageIndex,
  priceCompareStageIndex,
  PRE_MEETING_THRESHOLD_YUAN,
  type TaskRow,
} from './procurement-task-shared';
import { keywordWhere } from '../../common/utils/list-where';
// 阶段下标纯函数与阈值已迁至 shared，此处 re-export 以兼容既有引用（如 tender-bidders 集成测试）
export {
  PRE_MEETING_THRESHOLD_YUAN,
  noticeStageIndex,
  documentStageIndex,
  resultReportStageIndex,
  priceCompareStageIndex,
} from './procurement-task-shared';


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


// 状态码的单一事实源：任务状态见 `constants/procurementFlow.ts` 的 TASK_STATUS、
// 模块记录状态见 `constants/statuses.ts` 的 MODULE_RECORD_STATUS（此前本文件自造 STATUS_* 两份，已去除）。
// 任务状态 ↔ 合同阶段的映射见 `contractStageTaskStatus()`。

/** 状态 → 中文展示（已收敛至单一事实源 procurementFlow，此处透传导出以兼容既有引用） */
export { TASK_STATUS_LABELS };


@Injectable()
export class ProcurementTaskService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private tpl: ImportTemplateService,
    private contractService: ContractService,
    private dict: DictService,
    private forms: ProcurementStageFormsService,
  ) {}

  // ==================== 阶段表单 / 投标 / 成交报告 / 价格对比（已抽离至 ProcurementStageFormsService） ====================
  // P1-3：六个阶段表单与投标域整体拆入 ProcurementStageFormsService；控制器与内部 publish
  // 的调用点保持不变（走这里的同名转发）。主服务侧仅保留同名转发。

  async frameworkExplanation(taskId: string) {
    return this.forms.frameworkExplanation(taskId);
  }
  async saveFrameworkExplanation(taskId: string, body: any) {
    return this.forms.saveFrameworkExplanation(taskId, body);
  }
  async importPriceCompare(taskId: string) {
    return this.forms.importPriceCompare(taskId);
  }
  async preMeetingMinutes(taskId: string) {
    return this.forms.preMeetingMinutes(taskId);
  }
  async savePreMeetingMinutes(taskId: string, body: any) {
    return this.forms.savePreMeetingMinutes(taskId, body);
  }
  async notice(taskId: string) {
    return this.forms.notice(taskId);
  }
  async saveNotice(taskId: string, body: any) {
    return this.forms.saveNotice(taskId, body);
  }
  async document(taskId: string) {
    return this.forms.document(taskId);
  }
  async saveDocument(taskId: string, body: any) {
    return this.forms.saveDocument(taskId, body);
  }
  async resultReport(taskId: string) {
    return this.forms.resultReport(taskId);
  }
  async saveResultReport(taskId: string, body: any) {
    return this.forms.saveResultReport(taskId, body);
  }
  async rejectResultReport(taskId: string) {
    return this.forms.rejectResultReport(taskId);
  }
  async importResultReport(taskId: string, buffer?: Buffer, user?: any) {
    return this.forms.importResultReport(taskId, buffer, user);
  }
  /** publish 内部会用：成交报告发布时按快照补投标人 */
  async ensureBiddersFromSnapshot(task: { id: string; projectId: string }) {
    return this.forms.ensureBiddersFromSnapshot(task);
  }
  async bidders(taskId: string) {
    return this.forms.bidders(taskId);
  }
  async saveBidders(taskId: string, body: any) {
    return this.forms.saveBidders(taskId, body);
  }
  async saveEvaluations(taskId: string, body: any) {
    return this.forms.saveEvaluations(taskId, body);
  }
  async resultReportTemplate() {
    return this.forms.resultReportTemplate();
  }
  async priceCompare(taskId: string) {
    return this.forms.priceCompare(taskId);
  }
  async savePriceCompare(taskId: string, body: any) {
    return this.forms.savePriceCompare(taskId, body);
  }


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
    const kw = keywordWhere(['taskNo', 'content'], query.keyword);
    if (kw) where.OR = kw.OR;
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
      // 模块 → 采购类型/条件链/最小 stage 由 moduleStageBranches（单一事实源）推导。
      // 价格对比表（任务 3.6）同时属于「单项采购」与「引用框架协议」链，故按类型分支取 OR。
      const stageKey = ProcurementTaskService.MODULE_DELETE_MODELS[String(query.module)]?.stageKey;
      if (stageKey) {
        const all = moduleStageBranches(String(query.module), stageKey);
        const branches = query.type ? all.filter((b) => b.type === query.type) : all;
        if (!query.type) where.type = { in: Array.from(new Set(branches.map((b) => b.type))) };
        const or = branches.map((b) => ({
          AND: [
            { type: b.type },
            ...(b.preMeetingRequired == null ? [] : [{ preMeetingRequired: b.preMeetingRequired }]),
            { stage: { gte: b.stageGte } },
          ],
        }));
        // 无匹配分支（如把不存在的模块类型组合传入）→ 返回空集
        if (or.length) where.AND = [...(where.AND ?? []), { OR: or }];
        else where.id = { in: [] };
      }
    }

    const include: any = moduleDef ? { [moduleDef.rel]: { select: moduleDef.select } } : undefined;
    const [rows, total] = await Promise.all([
      this.prisma.procurementTask.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
      this.prisma.procurementTask.count({ where }),
    ]);
    // 任务 3.2：列表带出预计采购金额（万元），供「是否需要采前会会议纪要」判定与展示
    const amountMap = await estimatedAmountMap(this.prisma, rows.map((r) => r.id));
    return buildResult(
      rows.map((r: any) => {
        let module: any = null;
        if (moduleDef) {
          const rec = r[moduleDef.rel];
          if (rec) {
            module = { ...rec };
            // 采购公告联系人 / 联系电话为 JSON 字符串，解析后返回
            if (String(query.module) === 'NOTICE') {
              module.contacts = parseJsonArray<string>(rec.contacts);
              module.contactPhones = parseJsonArray<string>((rec as any).contactPhones);
            }
            // 问题五：框架事前说明「引用供应商及金额」/ 成交报告「拟推荐成交候选人」JSON 解析
            if (String(query.module) === 'FRAMEWORK_EXPLANATION') {
              module.referenceSuppliers = parseJsonArray<Record<string, any>>(rec.referenceSuppliers);
            }
            if (String(query.module) === 'RESULT_REPORT') {
              module.candidates = parseJsonArray<Record<string, any>>(rec.candidates);
            }
          }
        }
        return {
          ...serializeTask(r),
          estimatedAmountWan: toWan(amountMap.get(r.id) ?? 0),
          module,
        };
      }),
      total,
      query,
    );
  }


  async findOne(id: string) {
    const r = await taskOf(this.prisma, id);
    if (!r) throw new NotFoundException('采购任务不存在');
    const amountYuan = await estimatedAmountYuan(this.prisma, id);
    return {
      ...serializeTask(r, (await mainContract(this.prisma, id))?.id ?? null),
      estimatedAmountWan: toWan(amountYuan),
      stages: this.buildStages(r),
    };
  }

  /** 新建任务：自动编号，状态「未发起」，stage=0 */
  async create(
    data: { type?: string; content?: string; purpose?: string; preMeetingRequired?: boolean; procurementCategory?: string },
    projectId: string,
  ) {
    if (!isTaskType(data?.type)) throw new BadRequestException('请选择采购类型（引用框架协议/单项采购/紧急采购）');
    const content = String(data?.content ?? '').trim();
    if (!content) throw new BadRequestException('请填写采购内容');
    const purpose = data?.purpose != null ? String(data.purpose).trim() : '';
    const preMeetingRequired = data?.preMeetingRequired === true;
    const procurementCategory = data?.procurementCategory != null ? String(data.procurementCategory).trim() || null : null;

    // 并发新建（两个人同时点「新建」）仍可能取到同一号：撞 P2002 时重取一次，别让用户看到 500
    let created: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const taskNo = await this.nextTaskNo(projectId);
      try {
        created = await this.prisma.procurementTask.create({
          data: {
            projectId, taskNo, type: data.type as TaskType,
            content, purpose: purpose || null,
            status: TASK_STATUS.NOT_STARTED, stage: 0, preMeetingRequired,
            procurementCategory,
          },
        });
        break;
      } catch (err: any) {
        if (err?.code !== 'P2002' || attempt === 2) throw err;
      }
    }
    return serializeTask(created);
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
      /** 条款选择（业务口径 2026-10-16）：条款只在「合同条款」维护，这里只存 id */
      technicalClauseId?: string | null;
      qualityClauseId?: string | null;
      paymentClauseId?: string | null;
      acceptanceClauseId?: string | null;
      /** 乐观锁：列表/详情带回的版本号（缺失或过期一律 409） */
      version?: number;
    },
  ) {
    const current = await taskOf(this.prisma, id);
    if (!current) throw new NotFoundException('采购任务不存在');
    // 乐观锁（2026-11-13）：表有 version 列但更新不校验 —— 两人同时编辑会静默覆盖。
    // `assertVersion` 强制要求回传 version（缺失 409），与其它业务表同一套语义。
    assertVersion(current, data);
    const editableStatuses: readonly string[] = [TASK_STATUS.NOT_STARTED, TASK_STATUS.LIST_EDITING];
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
      technicalClauseId?: string | null;
      qualityClauseId?: string | null;
      paymentClauseId?: string | null;
      acceptanceClauseId?: string | null;
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

    // ==================== 条款选择（业务口径 2026-10-16） ====================
    // 四个 id 可空（新项目条款库可能为空）；传了就校验"存在 + 类型匹配"，然后**把条款正文
    // 快照进既有文本列** —— 下游 20+ 处消费点（采前会/公告/文件/成交报告/Word 导出）零改动。
    const clauseInput: {
      technicalClauseId?: string | null;
      qualityClauseId?: string | null;
      paymentClauseId?: string | null;
      acceptanceClauseId?: string | null;
    } = {};
    let hasClauseInput = false;
    for (const k of ['technicalClauseId', 'qualityClauseId', 'paymentClauseId', 'acceptanceClauseId'] as const) {
      if (data?.[k] === undefined) continue;
      hasClauseInput = true;
      clauseInput[k] = data[k] === null || data[k] === '' ? null : String(data[k]);
    }
    if (hasClauseInput) {
      const snapshots = await this.resolveClauseSnapshots(clauseInput);
      Object.assign(patch, clauseInput, snapshots);
    }

    const updated = await versionedUpdate(this.prisma.procurementTask, id, current.version, patch);
    return { ...serializeTask(updated), stages: this.buildStages(updated) };
  }

  /**
   * 校验条款选择并产出**正文快照**（业务口径 2026-10-16）。
   *
   * 规则（纯逻辑在 `clause-snapshot.ts`，由 `clauseSelection.spec.mts` 锁定；本方法只做查库与报错）：
   * - id 必须存在于 `Clause` 且 `type` 与槽位匹配（写错类型会让模板变量拿到奇怪内容，从界面看不出来）；
   * - `techQuality` = 技术条款正文 +（选了质量条款时）质量条款正文（两段拼接）；
   *   `acceptanceMethod` = 验收方式正文；`paymentMethod` = 付款条件正文；
   * - 某槽位传 `null` = 清除该选择 → 对应文本列**一并清空**（否则界面看着没选、变量却还有值）。
   *
   * 快照语义：条款库后续被改，**不影响已保存的采购任务**（下游采前会/公告/文件/成交报告读的都是
   * 文本列，跟着快照走）。
   */
  private async resolveClauseSnapshots(input: {
    technicalClauseId?: string | null;
    qualityClauseId?: string | null;
    paymentClauseId?: string | null;
    acceptanceClauseId?: string | null;
  }): Promise<ClauseSnapshot> {
    const ids = Object.values(input).filter((v): v is string => !!v);
    const fetched = ids.length
      ? await this.prisma.clause.findMany({ where: { id: { in: ids } } })
      : [];
    const byId = new Map(fetched.map((c) => [c.id, c]));
    return resolveClauseSnapshot(
      input,
      (id) => byId.get(id),
      () => new BadRequestException('所选条款不存在，请刷新后重试'),
      (slot, expected, actual) =>
        new BadRequestException(
          `条款类型与所选槽位不匹配（${slot} 需要 ${CLAUSE_TYPE_LABELS[expected]}，实际为 ${
            (actual as string) ?? '未分类'
          }）`,
        ),
    );
  }

  /**
   * 发布当前阶段的子任务（前置约束：前面的阶段必须全部已发布）。
   * 发布后 stage+1，状态流转到下一阶段的「编制中」；若全部阶段发布完毕则进入合同阶段状态。
   */
  async publish(id: string, user?: any) {
    const current = await taskOf(this.prisma, id);
    if (!current) throw new NotFoundException('采购任务不存在');

    // 任务 3.2：发布总采购清单（阶段 0 → 1）时，按预计采购金额自动判定是否需要采前会会议纪要。
    // 规则：仅「单项采购」类型；预计采购金额 ≥ 100 万元 → 生成该模块，< 100 万不生成。
    let preMeetingRequired = current.preMeetingRequired;
    if (current.stage === 0 && current.type === 'SINGLE') {
      const amountYuan = await estimatedAmountYuan(this.prisma, current.id);
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
    // 注意：引用框架协议链已插入「价格对比表」（stage 1），框架说明相应后移到 stage 2
    const frameworkExplainIdx =
      current.type === 'FRAMEWORK'
        ? stageChain('FRAMEWORK', false).findIndex((s) => s.key === 'FRAMEWORK_EXPLAIN')
        : -1;
    if (current.stage === frameworkExplainIdx && frameworkExplainIdx >= 0) {
      const expl = await this.prisma.frameworkExplanation.findUnique({ where: { taskId: current.id } });
      if (!expl || !String(expl.frameworkIntro ?? '').trim()) {
        throw new BadRequestException('请先编辑并保存框架协议事前说明（至少填写框架简介）后再发布');
      }
      // 需求：框架协议事前说明未勾选单位则无法发起（后端兜底，与前端 openPublishPreview 校验一致）
      const refSuppliers = parseJsonArray<{ supplier?: string }>(expl.referenceSuppliers).filter((r) =>
        String(r?.supplier ?? '').trim(),
      );
      if (!refSuppliers.length) {
        throw new BadRequestException('请先在「引用供应商及金额」中勾选至少一家单位后再发布框架协议事前说明');
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
      const supplierCount = parseJsonArray(report.suppliers).length;
      if (supplierCount === 0) {
        throw new BadRequestException(
          '请先导入「响应单位情况汇总表」（至少一条响应单位）后再发布',
        );
      }
    }
    // 任务 3.6：发布「采购价格对比表」前必须已保存内容（计价方式与采购效益分析说明为必填）
    // 单项采购与引用框架协议均有此阶段，统一按阶段链取下标
    const priceIndex = priceCompareStageIndex(current);
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
    // 合同阶段的状态细分依赖关联合同状态；此查询同时充当「是否已生成合同」的幂等判据
    const linked = nextStage >= chain.length ? await mainContract(this.prisma, id) : null;
    const nextStatus = this.deriveStatus(current.type, preMeetingRequired, nextStage, linked?.status);
    /**
     * 「推进阶段 + 回填本阶段发布时间」是**一次逻辑写入**（2026-11-22 审计）：
     * 改造前是 1 次 task.update + 最多 6 次 xxx.updateMany 裸写，中途抛错就留下
     * 「阶段已推进、模块仍显示编辑中」或 `publishedAt` 只写了一半。
     * 事务只包"状态类"写入；自动生成合同 / 价格对比表回填是**可失败的附属动作**，
     * 留在事务外（失败不阻断发布，与改造前口径一致）。
     */
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.procurementTask.update({
        where: { id },
        data: {
          stage: nextStage,
          status: nextStatus,
          // 采前会要求随预计采购金额自动落库（仅单项采购在总清单发布时判定）
          ...(preMeetingRequired !== current.preMeetingRequired ? { preMeetingRequired } : {}),
          version: { increment: 1 },
        },
      });
      // 事前说明阶段发布 → 回填发布时间（状态由 stage 推导：已发布即「已完成」）
      // ⚠️ 阶段下标必须用上面按阶段链算出的 frameworkExplainIdx（框架链里事前说明是 stage 2），
      // 不能硬写 1——1 是「价格对比表」，会导致刚发布价格对比表就把事前说明标成已发布、
      // 前端 ModuleListPage 据此提前显示「已完成」。
      if (frameworkExplainIdx >= 0 && current.stage === frameworkExplainIdx) {
        await tx.frameworkExplanation.updateMany({
          where: { taskId: id, publishedAt: null },
          data: { publishedAt: new Date() },
        });
      }
      // 采前会阶段发布 → 回填发布时间
      if (current.stage === 1 && current.type === 'SINGLE' && preMeetingRequired) {
        await tx.preMeetingMinutes.updateMany({
          where: { taskId: id, publishedAt: null },
          data: { publishedAt: new Date() },
        });
      }
      // 任务 3.3：采购公告阶段发布 → 回填发布时间（状态 编辑中 → 已完成）
      if (noticeIndex >= 0 && current.stage === noticeIndex) {
        await tx.procurementNotice.updateMany({
          where: { taskId: id, publishedAt: null },
          data: { publishedAt: new Date() },
        });
      }
      // 任务 3.4：采购文件阶段发布 → 回填发布时间（状态 编辑中 → 已完成）
      if (documentIndex >= 0 && current.stage === documentIndex) {
        await tx.procurementDocument.updateMany({
          where: { taskId: id, publishedAt: null },
          data: { publishedAt: new Date() },
        });
      }
      // 任务 3.5：成交报告阶段发布 → 回填发布时间（状态 编辑中 → 已完成）
      if (reportIndex >= 0 && current.stage === reportIndex) {
        await tx.procurementResultReport.updateMany({
          where: { taskId: id, publishedAt: null },
          data: { publishedAt: new Date() },
        });
      }
      // 任务 3.6：采购价格对比表阶段发布 → 回填发布时间（状态 编辑中 → 已完成）
      if (priceIndex >= 0 && current.stage === priceIndex) {
        await tx.procurementPriceCompare.updateMany({
          where: { taskId: id, publishedAt: null },
          data: { publishedAt: new Date() },
        });
      }
      return next;
    });

    // 补充一：全部阶段发布完毕（单项采购=采购价格对比表 / 引用框架协议=框架协议事前说明）后，
    // 自动在「合同起草」生成关联合同（草稿）并关联本任务。
    // 幂等判据：本任务是否已有关联合同——关联只由 Contract.taskId 一条表达，故直接查合同表。
    if (nextStage >= chain.length && !linked) {
      try {
        await this.generateLinkedContract(current, current.projectId, user);
      } catch (err) {
        // 自动生成失败不阻断任务发布流转（合同可由用户在起草页手动新建）
        console.error('[采购任务] 自动生成关联合同失败：', err);
      }
    }

    // 框架协议类型：价格对比表明细自动写入事前说明「价格对比表」。
    // 注意框架链中价格对比表在事前说明之前，此刻说明记录往往尚未创建（!existing）——
    // 由 importPriceCompare 的 upsert 创建；用户已手动填写（priceCompareRows 非空）时不覆盖。
    if (priceIndex >= 0 && current.stage === priceIndex && current.type === 'FRAMEWORK') {
      const existing = await this.prisma.frameworkExplanation.findUnique({ where: { taskId: id } });
      if (!existing || !String(existing.priceCompareRows ?? '').trim()) {
        try {
          await this.importPriceCompare(id);
        } catch {
          /* 价格对比表无明细时静默跳过 */
        }
      }
    }

    return { ...serializeTask(updated), stages: this.buildStages(updated) };
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
    // 合同类型由「采购类型 + 采购品类」统一推导（与 server/src/constants/procurementFlow.ts 的 deriveContractType 一致）
    const typeCode = deriveContractType(type as TaskType, (category as ContractCategory) ?? null);
    const typeName = CONTRACT_TYPE_LABELS[typeCode] ?? typeCode;
    // @no-limit: 按类型名匹配合同模板（模板总数级）
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
   * 补充一/任务 6：采购任务全部阶段发布完毕后，按「采购类型 + 采购品类」自动生成草稿合同并关联本任务。
   * 多单位 → 多合同：
   *  - 单项采购：按成交报告「拟推荐成交候选人」逐单位生成（候选单位即供应商）；
   *  - 引用框架协议：按事前说明「引用供应商及金额」逐单位生成；
   *  - 紧急采购：生成单份合同（无多单位概念）。
   * 所有合同通过 taskId 一对多关联本任务，下游（签章/收领单/日报/结算/付款）各自独立。
   * 关联关系只由 Contract.taskId 一条表达（采购任务侧不再有冗余的 contractId 字段）。
   */
  private async generateLinkedContract(task: TaskRow, projectId: string, user?: any) {
    const resolved = await this.resolveContractTemplate(task.type, task.procurementCategory);
    if (!resolved) return null; // 采购品类缺失或不匹配，跳过自动生成

    // 确定合同单位（名称 / 金额）：
    //  - 单项采购：取**结构化投标单位**里状态为「中标」的行（`ProcurementBidder`，勾选候选人时写入），
    //    不再直接读 JSON `candidates`——JSON 只作发布快照，结构化行才是定标的事实源；
    //    存量任务（结构化行尚未建立）在这里**幂等回填**后取，新旧数据走同一条路径；
    //  - 框架协议：取事前说明「引用供应商及金额」。
    // 单位解析统一走 resolveContractUnits（纯函数，单测覆盖）：无单位时回退单份合同（紧急采购）。
    let candidates: Array<Record<string, any>> = [];
    let referenceSuppliers: Array<Record<string, any>> = [];
    if (task.type === 'SINGLE') {
      await this.ensureBiddersFromSnapshot({ id: task.id, projectId });
      const bidders = await this.prisma.procurementBidder.findMany({
        where: { taskId: task.id },
        orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
      });
      candidates = candidatesFromBidders(bidders as unknown as Array<Record<string, any>>);
    } else if (task.type === 'FRAMEWORK') {
      const fe = await this.prisma.frameworkExplanation.findUnique({ where: { taskId: task.id } });
      referenceSuppliers = parseJsonArray<Record<string, any>>(fe?.referenceSuppliers);
    }
    const units = resolveContractUnits(task.type, candidates, referenceSuppliers);

    // 采购总清单：用于把「采购阶段已算过的量价」带入合同的起草期清单，避免在合同里重录
    const totalItems = await this.prisma.procurementTotalItem.findMany({
      where: { taskId: task.id },
      orderBy: { sortOrder: 'asc' },
    });

    const created: any[] = [];
    try {
      for (const u of units) {
        const supplierId = u.name ? await resolveSupplierId(this.prisma, u.name) : null;
        const { code } = await this.contractService.nextCode({ typeCode: resolved.typeCode, projectId });
        if (!code) continue;
        const contract = await this.contractService.create(
          {
            code,
            typeCode: resolved.typeCode,
            // 五态（PURCHASE/LEASE/…）不落库：它是 `typeCode` + 采购品类的**派生值**，
            // 由纯函数 `deriveContractType()` 推导（见 constants/procurementFlow.ts），
            // 存一份副本只会制造"同一取值空间两处"的口径风险（2026-10-16 删除该列，全库已无 DB enum）。
            taskId: task.id,
            supplierId,
            isFramework: task.type === 'FRAMEWORK' ? 'Y' : 'N',
            templateId: resolved.templateId,
            amount: u.amount,
            status: CONTRACT_STATUS.DRAFT,
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
        created.push(contract);

        // 采购总清单 → 起草期合同清单（计划价=控制价）。
        // 多单位场景每份合同都带入同一份清单，由用户按成交单位裁剪；带入失败**不阻断**合同生成。
        if (totalItems.length) {
          try {
            await this.contractService.seedDraftFromProcurementItems(
              contract.id,
              totalItems.map((it) => ({
                materialBaseId: it.materialBaseId,
                qty: num(it.qty),
                priceBeforeTax: num(it.planPrice),
                unit: it.unit,
              })),
            );
          } catch (err) {
            console.error('[采购任务] 采购总清单带入合同清单失败（不阻断合同生成）：', err);
          }
        }
      }
    } catch (err) {
      // 任务 6：批量生成任一失败则回滚已生成的合同，避免产生残缺多合同。
      // 删合同是 contract 模块的语义（级联清附件/变更日志/清单，遇到日报或还款协议则 Restrict 拒删），
      // 因此走它的写入原语，不再由本模块直写合同表（2026-11-23 门禁修复）。
      if (created.length) {
        try {
          await deleteContractsByIds(this.prisma, created.map((c) => c.id));
        } catch (cleanupErr) {
          // 回滚是**尽力而为**：合同已挂日报/还款协议时删不掉，只能把残缺合同暴露在日志里。
          // （原实现是 `.catch(() => undefined)`，连失败都看不见。）
          console.error('[采购任务] 回滚已生成合同失败，需人工清理：', created.map((c) => c.id), cleanupErr);
        }
      }
      throw err;
    }
    return created[0] ?? null;
  }



  /**
   * 补充四：采购文件「导出合同模板 / 预览合同模板」数据来源。
   * 返回与任务「采购类型 + 采购品类」匹配的合同模板内容，以及采购发起填写的技术质量/验收/付款标准，
   * 供前端注入模板占位符并生成 Word。
   */
  async contractTemplate(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    const resolved = await this.resolveContractTemplate(task.type, task.procurementCategory);
    const tpl = resolved?.templateId
      ? await this.prisma.contractTemplate.findUnique({ where: { id: resolved.templateId } })
      : null;
    return {
      task: serializeTask(task),
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
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    const items = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      frozen: task.stage >= 1,
      status: task.status,
      statusLabel: TASK_STATUS_LABELS[task.status as keyof typeof TASK_STATUS_LABELS] ?? task.status,
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
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.stage >= 1) throw new BadRequestException('总采购清单已发布冻结，不可修改');
    if (task.status !== TASK_STATUS.NOT_STARTED) throw new BadRequestException('任务已进入后续流程，总采购清单不可修改');
    if (!Array.isArray(items)) throw new BadRequestException('清单数据无效');

    // 数量/单价均不允许为负：负控制价会拉低「预计采购金额」（进而影响采前会门槛），
    // 负数还会随总清单带入合同起草清单。
    const num = numOf('数量/单价', { min: 0 });

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
    // @no-limit: 计量单位字典项（<100）
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
      // 需求修正（修改一 · 2.2）：计量单位与基础库默认值不符 → 提交时同步到物资基础库
      // （唯一键为 name+spec，更新该记录单位）。物资表归 material 模块，走它的写入原语。
      for (const row of normalized) {
        const base = baseMap.get(row.materialBaseId);
        if (base && base.unit !== row.unit) {
          await updateMaterialBaseUnit(tx, base.id, row.unit);
        }
      }
    });

    // 需求修正（修改一 · 2.2）：判断时机 = 总采购清单保存后。
    // 系统自动计算「预计采购合价」合计（Σ 预计采购单价 × 暂定数量），
    // 单项采购且合计 ≥ 100 万元 → 生成采前会会议纪要模块；引用框架协议或合计 < 100 万 → 不生成。
    let preMeetingRequired = task.preMeetingRequired;
    if (task.type === 'SINGLE' && task.stage === 0) {
      const amountYuan = await estimatedAmountYuan(this.prisma, taskId);
      preMeetingRequired = amountYuan >= PRE_MEETING_THRESHOLD_YUAN;
      if (preMeetingRequired !== task.preMeetingRequired) {
        await this.prisma.procurementTask.update({
          where: { id: taskId },
          // 写入即 bump：与 update() 的乐观锁语义保持一致（否则并发编辑时版本号不反映这次写入）
          data: { preMeetingRequired, version: { increment: 1 } },
        });
      }
    }

    const list = await this.totalList(taskId);
    const amountYuan = await estimatedAmountYuan(this.prisma, taskId);
    return {
      ...list,
      estimatedAmountYuan: round2(amountYuan),
      estimatedAmountWan: toWan(amountYuan),
      preMeetingRequired,
    };
  }

  // Decimal 字段统一 num() 归一为 number 再出接口，避免 Prisma.Decimal 对象直接序列化
  private serializeItem(i: any) {
    return {
      id: i.id,
      materialBaseId: i.materialBaseId,
      materialName: i.materialName,
      spec: i.spec,
      unit: i.unit,
      qty: num(i.qty),
      incomePrice: num(i.incomePrice),
      stdCost: num(i.stdCost),
      marketPrice: num(i.marketPrice),
      infoPrice: num(i.infoPrice),
      planPrice: num(i.planPrice),
      sortOrder: i.sortOrder,
    };
  }



  /**
   * 同步合同阶段状态（批次后续「生成合同」调用）：
   * - 任务全部阶段已发布 → 按**主合同**状态映射
   *   （DRAFT→合同编制中 / APPROVING→合同待签章 / SIGNED→已完成）
   * - 尚未到合同阶段 → 不变更
   * - 无关联合同 → 按「合同编制中」（合同可由用户在起草页手动新建）
   *
   * 注：`contract.service` 在合同签章/状态互转时会**自动**调用同一套映射，
   * 本端点用于人工兜底校正（如历史数据、外部写入）。
   */
  async syncContractStatus(id: string) {
    const current = await taskOf(this.prisma, id);
    if (!current) throw new NotFoundException('采购任务不存在');
    const chain = stageChain(current.type, current.preMeetingRequired);
    if (current.stage < chain.length) return serializeTask(current); // 未到合同阶段
    const linked = await mainContract(this.prisma, id);
    const nextStatus = this.deriveStatus(
      current.type,
      current.preMeetingRequired,
      current.stage,
      linked?.status,
    );
    const contractId = linked?.id ?? null;
    if (nextStatus === current.status) return serializeTask(current, contractId);
    const updated = await this.prisma.procurementTask.update({
      where: { id }, data: { status: nextStatus, version: { increment: 1 } },
    });
    return serializeTask(updated, contractId);
  }

  async remove(id: string) {
    const current = await taskOf(this.prisma, id);
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

    const current = await taskOf(this.prisma, id);
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
      ...serializeTask(updated),
      stages: this.buildStages(updated),
      wasPublished,
      message: wasPublished ? '已删除该模块并回退流程，上一阶段恢复可编辑' : '已清除该模块草稿',
    };
  }

  /**
   * 采购编号：PROC-YYYYMMDD-XXX（按当日已有任务取**最大序号** +1）。
   * ⚠️ 不能用 `count() + 1`：删掉当日中间某个任务后 count 变小，就会与已存在的最大号重复，
   * 撞上 `@@unique([projectId, taskNo])` 抛未捕获的 P2002（前端看到 500）。
   */
  private async nextTaskNo(projectId: string): Promise<string> {
    const day = localDayKey().replace(/-/g, '');
    const prefix = `PROC-${day}-`;
    // @no-limit: 只取本项目当天的采购任务编号，用于算下一个流水号
    const rows = await this.prisma.procurementTask.findMany({
      where: { projectId, taskNo: { startsWith: prefix } },
      select: { taskNo: true },
    });
    const max = rows.reduce((m, r) => {
      const seq = parseInt(String(r.taskNo ?? '').slice(prefix.length), 10);
      return Number.isFinite(seq) && seq > m ? seq : m;
    }, 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  /**
   * 由阶段进度推导工作流状态。
   * 阶段链内取该阶段的编辑中状态；**合同阶段**（stage 已达链尾）的细分状态由关联合同状态决定
   * （草稿→合同编制中 / 待签章→合同待签章 / 已签章→已完成），映射见
   * `contractStageTaskStatus`（单一事实源）。
   */
  private deriveStatus(
    type: string,
    preMeetingRequired: boolean,
    stage: number,
    contractStatus?: string | null,
  ): string {
    const chain = stageChain(type, preMeetingRequired);
    if (stage >= chain.length) return contractStageTaskStatus(contractStatus);
    return chain[stage].status;
  }

  /** 阶段链视图：done（已发布）/ editing（当前）/ locked（前置未发布）；末尾附合同阶段 */
  private buildStages(r: TaskRow) {
    const chain = stageChain(r.type, r.preMeetingRequired);
    // 顺序门禁视图统一由 stageView / contractStageState 推导（单一事实源，可单测）
    const states = stageView(chain, r.stage);
    const stages = chain.map((s, i) => ({ key: s.key, label: s.label, state: states[i] }));
    stages.push({
      key: STAGE_KEYS.CONTRACT,
      label: '生成合同',
      state: contractStageState(r.stage, chain.length, r.status, TASK_STATUS.COMPLETED),
    });
    return stages;
  }


}
