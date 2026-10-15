import { BadRequestException } from '@nestjs/common';

// ⚠️ 本文件被 `server/test/*.spec.mts` 直接 import（Node 原生擦除类型加载），
// 因此**不能有相对路径的运行时 import**（Node ESM 不做扩展名推断）。
// 合同状态 code 的事实源在 `./statuses.ts`，此处按字面量书写，由
// `server/test/statusCodes.spec.mts` 断言 `Object.keys(CONTRACT_STATUS_TO_TASK_STATUS)`
// 与 `Object.values(CONTRACT_STATUS)` 相等来防漂移。

/**
 * 采购工作流单一事实源（后端 gating 与前端展示均以本文件为准，杜绝双端漂移）。
 * 阶段链只含「可发布的子阶段」；合同阶段（CONTRACT）为末态，不计入链。
 */
export interface StageDef {
  key: string;
  label: string;
  /** 该阶段进入编制中时对应的工作流状态 */
  status: string;
}

export const TOTAL_LIST: StageDef = { key: 'TOTAL_LIST', label: '编制总采购清单', status: 'LIST_EDITING' };
export const PRE_MEETING: StageDef = { key: 'PRE_MEETING', label: '采前会会议纪要', status: 'PRE_MEETING_EDITING' };
export const NOTICE: StageDef = { key: 'NOTICE', label: '采购公告', status: 'NOTICE_EDITING' };
export const DOCUMENT: StageDef = { key: 'DOCUMENT', label: '采购文件', status: 'DOCUMENT_EDITING' };
export const RESULT_REPORT: StageDef = { key: 'RESULT_REPORT', label: '成交报告', status: 'RESULT_EDITING' };
export const PRICE_COMPARE: StageDef = { key: 'PRICE_COMPARE', label: '采购价格对比表', status: 'PRICE_COMPARE_EDITING' };
export const FRAMEWORK_EXPLAIN: StageDef = { key: 'FRAMEWORK_EXPLAIN', label: '框架协议事前说明', status: 'FRAMEWORK_EDITING' };

/**
 * 阶段 key 常量表（供 gating / 单测引用，避免散落魔法字符串导致链定义漂移）。
 * CONTRACT 为末态阶段，不在 stageChain 之内。
 */
export const STAGE_KEYS = {
  TOTAL_LIST: TOTAL_LIST.key,
  PRE_MEETING: PRE_MEETING.key,
  NOTICE: NOTICE.key,
  DOCUMENT: DOCUMENT.key,
  RESULT_REPORT: RESULT_REPORT.key,
  PRICE_COMPARE: PRICE_COMPARE.key,
  FRAMEWORK_EXPLAIN: FRAMEWORK_EXPLAIN.key,
  CONTRACT: 'CONTRACT',
} as const;

/** 阶段状态：done 已发布 / editing 当前可编辑可发布 / locked 前置未发布（顺序门禁） */
export type StageState = 'done' | 'editing' | 'locked';

/**
 * 任务状态 → 中文展示（前端 web/src/constants/procurementWorkflow.ts 与之镜像，
 * 由 test/frontendChainParity.spec.ts 做漂移锁）。
 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  NOT_STARTED: '未发起',
  LIST_EDITING: '总清单编制中',
  PRE_MEETING_EDITING: '采前会纪要编制中',
  NOTICE_EDITING: '采购公告编制中',
  DOCUMENT_EDITING: '采购文件编制中',
  RESULT_EDITING: '成交报告编制中',
  PRICE_COMPARE_EDITING: '价格对比表编制中',
  FRAMEWORK_EDITING: '事前报告编制中',
  CONTRACT_EDITING: '合同编制中',
  CONTRACT_APPROVING: '合同待签章',
  COMPLETED: '已完成',
};

/** 采购类型（本项目仅此三类） */
export const TASK_TYPES = ['FRAMEWORK', 'SINGLE', 'EMERGENCY'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const isTaskType = (v: unknown): v is TaskType =>
  typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v);

/**
 * 任务类型 → 阶段链（不含合同阶段；采前会为条件阶段）。
 * - 紧急采购：仅总清单 → 合同（无采前会/公告/文件/成交报告/价格对比表）
 * - 引用框架协议：总清单 → 价格对比表 → 框架协议事前说明（价格对比表数据灌入事前说明）
 * - 单项采购：总清单 →(采前会)→ 公告 → 文件 → 成交报告 → 价格对比表 → 合同
 */
export function stageChain(type: string, preMeetingRequired: boolean): StageDef[] {
  if (type === 'EMERGENCY') return [TOTAL_LIST];
  if (type === 'FRAMEWORK') return [TOTAL_LIST, PRICE_COMPARE, FRAMEWORK_EXPLAIN];
  if (type === 'SINGLE') {
    const chain = [TOTAL_LIST];
    if (preMeetingRequired) chain.push(PRE_MEETING);
    chain.push(NOTICE, DOCUMENT, RESULT_REPORT, PRICE_COMPARE);
    return chain;
  }
  throw new BadRequestException('无效的采购类型');
}

/** 采购品类（前端存为「物资/租赁」；决定采购/租赁子类型） */
export type ContractCategory = '物资' | '租赁' | null;

/**
 * 合同类型（五态）——**code 的单一事实源**（评审意见：核心枚举不用裸字符串）。
 *
 * ⚠️ 它**不再与任何 DB enum 对应**：此前 `schema.prisma` 里有一个 `enum ContractType` 作为它的副本，
 * 2026-10-16 连列一起删除（那一列全仓无读者，且铁律 4 是"字典驱动、不加数据库枚举"）——
 * 现在全库**零 DB enum**，五态只由本常量 + `deriveContractType()` 表达。
 * 它是字典 `contract_type` 取值的**子集**（字典另有 `FRAMEWORK`：框架协议不进这五态），
 * 由 `server/test/statusCodes.spec.mts` 锁定（该文件另有一条锁：schema 里不得出现任何 enum）。
 */
export const CONTRACT_TYPES = ['PURCHASE', 'LEASE', 'PURCHASE_EXEC', 'LEASE_EXEC', 'EMERGENCY'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/**
 * 采购任务状态（`ProcurementTask.status`，**非字典驱动**；标签见 `TASK_STATUS_LABELS`）。
 * 与合同状态的映射见 `CONTRACT_STATUS_TO_TASK_STATUS`。
 */
export const TASK_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  LIST_EDITING: 'LIST_EDITING',
  PRE_MEETING_EDITING: 'PRE_MEETING_EDITING',
  NOTICE_EDITING: 'NOTICE_EDITING',
  DOCUMENT_EDITING: 'DOCUMENT_EDITING',
  RESULT_EDITING: 'RESULT_EDITING',
  PRICE_COMPARE_EDITING: 'PRICE_COMPARE_EDITING',
  FRAMEWORK_EDITING: 'FRAMEWORK_EDITING',
  CONTRACT_EDITING: 'CONTRACT_EDITING',
  CONTRACT_APPROVING: 'CONTRACT_APPROVING',
  COMPLETED: 'COMPLETED',
} as const;
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

/** 合同类型推导：采购类型 + 采购品类（物资→采购；租赁→租赁） */
export function deriveContractType(taskType: TaskType, category: ContractCategory): ContractType {
  const isLease = category === '租赁';
  if (taskType === 'EMERGENCY') return 'EMERGENCY';
  if (taskType === 'FRAMEWORK') return isLease ? 'LEASE_EXEC' : 'PURCHASE_EXEC';
  return isLease ? 'LEASE' : 'PURCHASE';
}

/** 合同类型展示标签 */
export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  PURCHASE: '采购合同',
  LEASE: '租赁合同',
  PURCHASE_EXEC: '采购执行合同',
  LEASE_EXEC: '租赁执行合同',
  EMERGENCY: '紧急采购合同',
};

/**
 * 顺序门禁视图：`stage` = 已发布阶段数。
 * - i < stage → done（该阶段已发布）
 * - i === stage → editing（当前阶段，可编辑/可发布）
 * - i > stage → locked（前置阶段未发布，锁定不可进入）
 */
export function stageView(chain: StageDef[], stage: number): StageState[] {
  return chain.map((_, i) => (i < stage ? 'done' : i === stage ? 'editing' : 'locked'));
}

/**
 * 合同阶段（末态，不计入 stageChain）状态：
 * 全部子阶段发布完毕 → editing；任务已完成 → done；否则 locked。
 */
export function contractStageState(
  stage: number,
  chainLength: number,
  taskStatus: string,
  completedStatus = TASK_STATUS.COMPLETED,
): StageState {
  if (taskStatus === completedStatus) return 'done';
  return stage < chainLength ? 'locked' : 'editing';
}

/**
 * 合同阶段的「合同状态 → 采购任务状态」映射（单一事实源）。
 *
 * 采购任务走完阶段链后进入合同阶段，其细分状态由**关联合同的状态**决定：
 * - 草稿               → 合同编制中（CONTRACT_EDITING）
 * - 待签章（APPROVING） → 合同待签章（CONTRACT_APPROVING）
 * - 已签章（SIGNED）    → 已完成（COMPLETED，此时「生成合同」阶段显示为 done）
 *
 * 前端 `web/src/constants/procurementWorkflow.ts` 已按同一组状态码准备展示（标签/颜色），
 * 两侧漂移由 `frontendChainParity.spec.mts` 锁定。
 */
export const CONTRACT_STATUS_TO_TASK_STATUS: Record<string, string> = {
  DRAFT: TASK_STATUS.CONTRACT_EDITING,
  APPROVING: TASK_STATUS.CONTRACT_APPROVING,
  SIGNED: TASK_STATUS.COMPLETED,
};

/** 由关联合同状态推导合同阶段的任务状态；未知/空值按「合同编制中」处理 */
export function contractStageTaskStatus(contractStatus?: string | null): string {
  return CONTRACT_STATUS_TO_TASK_STATUS[String(contractStatus ?? 'DRAFT')] ?? TASK_STATUS.CONTRACT_EDITING;
}

/**
 * 子模块 → 可归属的采购类型（模块列表「阶段门槛 + 类型过滤」的单一事实源）。
 * - 价格对比表（任务 3.6）：单项采购链与引用框架协议链均含此阶段；
 * - 采前会 / 采购公告 / 采购文件 / 成交报告：仅单项采购链；
 * - 框架协议事前说明：仅引用框架协议链；
 * - 紧急采购链仅有「总清单 → 生成合同」，无以上任何子模块。
 */
export const MODULE_TASK_TYPES: Record<string, TaskType[]> = {
  PRE_MEETING: ['SINGLE'],
  NOTICE: ['SINGLE'],
  DOCUMENT: ['SINGLE'],
  RESULT_REPORT: ['SINGLE'],
  PRICE_COMPARE: ['SINGLE', 'FRAMEWORK'],
  FRAMEWORK_EXPLANATION: ['FRAMEWORK'],
};

/** 模块列表的阶段门槛分支 */
export interface ModuleStageBranch {
  type: TaskType;
  /** 采前会为条件阶段：false / true 分别对应「无 / 有采前会」的链；非条件阶段为 null */
  preMeetingRequired: boolean | null;
  /** 进入该模块所需的最小 stage（= 该模块在对应链中的下标） */
  stageGte: number;
}

/**
 * 模块列表「阶段门槛」分支：该模块会在哪些采购类型 / 条件链上出现，以及最小 stage。
 * 例：PRICE_COMPARE → 引用框架协议(下标 1) + 单项采购无采前会(4) + 单项采购有采前会(5)。
 * 列表查询据此构造 OR 分支，避免把「不属于该类型」的任务混入导致详情接口 400。
 */
export function moduleStageBranches(moduleKey: string, stageKey: string): ModuleStageBranch[] {
  const types = MODULE_TASK_TYPES[String(moduleKey ?? '')] ?? [];
  const branches: ModuleStageBranch[] = [];
  for (const type of types) {
    if (type === 'SINGLE') {
      const noPm = stageChain('SINGLE', false).findIndex((s) => s.key === stageKey);
      const withPm = stageChain('SINGLE', true).findIndex((s) => s.key === stageKey);
      if (noPm >= 0) branches.push({ type, preMeetingRequired: false, stageGte: noPm });
      if (withPm >= 0) branches.push({ type, preMeetingRequired: true, stageGte: withPm });
    } else {
      const idx = stageChain(type, false).findIndex((s) => s.key === stageKey);
      if (idx >= 0) branches.push({ type, preMeetingRequired: null, stageGte: idx });
    }
  }
  return branches;
}

/** 合同单位（多合同生成：一份合同对应一个成交单位） */
export interface ContractUnit {
  /** 单位/供应商名称；无单位时为 null（紧急采购等单份合同场景） */
  name: string | null;
  /** 合同金额（元）；缺省为 null（由起草页补录） */
  amount: number | null;
}

/**
 * 多合同生成的单位解析（任务 6）：成交报告勾选的多单位 → 多合同。
 * - 单项采购：取成交报告「拟推荐成交候选人」（name / finalPreTaxPrice）；
 * - 引用框架协议：取事前说明「引用供应商及金额」（supplier / amount）；
 * - 紧急采购或上游无单位：回退为单份合同（name/amount 均为 null），保证「生成合同」阶段必有草稿。
 * 纯函数，无数据库依赖，便于单测挡「多合同漏生成 / 空单位生成」回归。
 */
export function resolveContractUnits(
  taskType: string,
  candidates: Array<Record<string, any>> = [],
  referenceSuppliers: Array<Record<string, any>> = [],
): ContractUnit[] {
  const toNum = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const pick = (rawName: unknown, rawAmount: unknown): ContractUnit => ({
    name: String(rawName ?? '').trim() || null,
    amount: toNum(rawAmount),
  });

  let units: ContractUnit[] = [];
  if (taskType === 'SINGLE') {
    units = candidates.map((c) => pick(c?.name, c?.finalPreTaxPrice));
  } else if (taskType === 'FRAMEWORK') {
    units = referenceSuppliers.map((r) => pick(r?.supplier, r?.amount));
  }
  // 仅保留有名称的单位，避免生成无主体的空合同
  units = units.filter((u) => u.name);
  return units.length ? units : [{ name: null, amount: null }];
}

/* ---------------- 招标域：投标/响应单位 → 定标 → 生成合同 ---------------- */

/**
 * 「中标」的投标单位状态 code。
 *
 * ⚠️ 本文件**不得有相对运行时 import**（`.spec.mts` 由 Node 原生擦除类型加载，ESM 不做扩展名推断，
 * 见 CLAUDE.md §5），故这里是**字面量**，与 `constants/statuses.ts` 的 `BIDDER_STATUS.WON`
 * 由 `test/statusCodes.spec.mts` 锁死——两边改名而这里没跟上，测试即红。
 */
export const BIDDER_WON = 'WON';

/** 其余状态同样以字面量持有（同上原因），仅本文件内部使用 */
const BIDDER_SHORTLISTED = 'SHORTLISTED';
const BIDDER_SUBMITTED = 'SUBMITTED';
/** 导入表里「是/否」两列的字面值（导入原样存字符串，不转布尔） */
const YES = '是';

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 取消中标（在第二轮报价表取消勾选）后，该单位回落到什么状态：
 * **通过第一轮报价的 = 入围（SHORTLISTED），否则回到已递交（SUBMITTED）**。
 * 只在这两者之间回落，不臆造其它状态（弃权/未中标等由用户显式维护，服务端不覆盖）。
 */
export function bidderStatusWhenNotWon(passedFirst?: string | null): string {
  return String(passedFirst ?? '').trim() === YES ? BIDDER_SHORTLISTED : BIDDER_SUBMITTED;
}

/**
 * 中标单位（结构化）→ 生成合同的「单位（名称 / 金额）」列表，即 `resolveContractUnits()` 的输入。
 *
 * 事实源是**结构化行**（`ProcurementBidder.status = WON`），JSON `candidates` 只作发布快照。
 * 取价口径：用户填的最终确认不含税价格优先；缺省时回退「第二轮（仅当通过第一轮）→ 第一轮」，
 * 与前端 `defaultFinalPrice()` 同口径。
 * 传入顺序即输出顺序（服务端按 `seq` / 创建时间排序后传入）。
 */
export function candidatesFromBidders(
  bidders: Array<Record<string, any>> = [],
): Array<{ name: string; finalPreTaxPrice: number | null }> {
  return bidders
    .filter((b) => String(b?.status ?? '') === BIDDER_WON)
    .map((b) => {
      const name = String(b?.bidderName ?? '').trim();
      if (!name) return null;
      const explicit = numOrNull(b?.finalPreTaxTotal);
      const second = numOrNull(b?.secondPreTaxTotal);
      const passed = String(b?.passedFirst ?? '').trim() === YES;
      const fallback = passed && second != null ? second : numOrNull(b?.firstPreTaxTotal);
      return { name, finalPreTaxPrice: explicit ?? fallback };
    })
    .filter((v): v is { name: string; finalPreTaxPrice: number | null } => v !== null);
}
