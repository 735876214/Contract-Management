/**
 * AI 预警 · **合同履约偏差**（矩阵课题 4-9）—— 判定口径、类型与容差。
 *
 * == 与 6-9 / 3-9 同一套架构 ==
 * 这一层是**纯函数**：不 import Prisma、不做 IO、不认识 HTTP，能被 `npm test` 裸跑。
 * 判定在程序里算完，交给 LLM 的只有 `facts` 里已经算好的字符串
 * （理由见 `.claude/rules/backend-conventions.md` 的「金额判定不让模型算」）。
 *
 * == 事实源 ==
 * `ContractFulfillment` 是履约节点的**唯一事实源**（`planDate` 计划 / `actualDate` 实际 /
 * `statusCode` = `MILESTONE_STATUS`）。「逾期」在系统里是**派生值不落库**
 * （见 `common/utils/milestone.ts` 的 `isMilestoneOverdue`）——本层沿用同一口径，
 * 并且把 `now` 显式注入，保证单测不依赖当天日期。
 *
 * == 本课题相对既有能力的增量 ==
 * 页面本来就会给节点标红（逾期）。预警要回答的是**逾期之外的偏差**：
 * 逾期多久/宽限期、完成了却没填实际日期、顺序倒挂、完成滞后、计划早于签订、
 * 履约与付款进度背离、已结算却没完工、签章合同根本没有节点。
 */

import { type Cents, centsToYuan } from '../common/money.ts';

/** 风险等级（沿用前两个课题的两级：业务只区分「必须马上看」与「复核一下」） */
export const FULFILLMENT_LEVEL = { HIGH: 'HIGH', MEDIUM: 'MEDIUM' } as const;
export type FulfillmentLevel = (typeof FULFILLMENT_LEVEL)[keyof typeof FULFILLMENT_LEVEL];

export const FULFILLMENT_LEVEL_LABELS: Record<FulfillmentLevel, string> = {
  HIGH: '高风险',
  MEDIUM: '需复核',
};

/**
 * 规则码（**单一事实源**）。C1–C8 对应 `docs/AI应用落地计划.md` M5 的八类偏差。
 */
export const FULFILLMENT_CODES = {
  /** C1 节点逾期未完成（超宽限期；逾期 > 30 天升级为高风险） */
  C1_OVERDUE: 'C1_OVERDUE',
  /** C2 已完成但没填实际日期（进度不可追溯） */
  C2_DONE_NO_ACTUAL: 'C2_DONE_NO_ACTUAL',
  /** C3 顺序倒挂：更早的计划节点未完成，更晚的却已完成 */
  C3_SEQUENCE_INVERTED: 'C3_SEQUENCE_INVERTED',
  /** C4 完成滞后：实际完成日期晚于计划超阈值 */
  C4_FINISH_LATE: 'C4_FINISH_LATE',
  /** C5 计划日期早于合同签订日期（计划明显填错，时间轴不可信） */
  C5_PLAN_BEFORE_SIGN: 'C5_PLAN_BEFORE_SIGN',
  /** C6 履约与付款背离：付款比例显著高于节点完成率 */
  C6_PROGRESS_PAYMENT_GAP: 'C6_PROGRESS_PAYMENT_GAP',
  /** C7 已出终期结算却仍有未完成节点 */
  C7_SETTLED_UNFINISHED: 'C7_SETTLED_UNFINISHED',
  /** C8 已签章合同没有任何履约节点（等于没有履约跟踪） */
  C8_NO_MILESTONE: 'C8_NO_MILESTONE',
} as const;
export type FulfillmentCode = (typeof FULFILLMENT_CODES)[keyof typeof FULFILLMENT_CODES];

export const FULFILLMENT_CODE_LABELS: Record<FulfillmentCode, string> = {
  C1_OVERDUE: '节点逾期未完成',
  C2_DONE_NO_ACTUAL: '完成未填实际日期',
  C3_SEQUENCE_INVERTED: '节点顺序倒挂',
  C4_FINISH_LATE: '完成滞后于计划',
  C5_PLAN_BEFORE_SIGN: '计划早于合同签订',
  C6_PROGRESS_PAYMENT_GAP: '付款快于履约',
  C7_SETTLED_UNFINISHED: '已结算仍有未完成节点',
  C8_NO_MILESTONE: '合同没有履约节点',
};

/** 命中对象：要么是某个节点，要么是合同本身（C6/C8 是合同级） */
export type FulfillmentEntity = 'milestone' | 'contract';

/**
 * 一条命中。
 *
 * `facts` 是**给人和模型看的事实行**：每行都写明比对了哪些值（日期、天数、比例），
 * 模型只允许引用这些数字（`auditNarrative` 会对账）。
 */
export interface FulfillmentFinding {
  code: FulfillmentCode;
  level: FulfillmentLevel;
  entity: FulfillmentEntity;
  /** 节点 ID 或合同 ID */
  entityId: string;
  contractId: string;
  contractCode: string;
  contractName: string;
  /** 模板串标题（后端生成，保证不缺描述） */
  title: string;
  facts: string[];
  /** 金额差额（元字符串）；与金额无关的规则为 null */
  amountDiff: string | null;
}

/** 合同行（只需要履约判定用得到的字段；`amount`/`changeAmount` 用于链式当前金额） */
export interface FulfillmentContractRow {
  id: string;
  code?: string | null;
  name?: string | null;
  amount?: unknown;
  changeAmount?: unknown;
  parentContractId?: string | null;
  signDate?: Date | string | null;
  signedDate?: Date | string | null;
  status?: string | null;
  execStatus?: string | null;
}

export interface MilestoneRow {
  id: string;
  contractId: string;
  name?: string | null;
  planDate?: Date | string | null;
  actualDate?: Date | string | null;
  statusCode?: string | null;
  owner?: string | null;
}

/** 付款行（只用有效状态，口径同 6-9：`FAILED`/`REFUNDED` 不算） */
export interface FulfillmentPaymentRow {
  id: string;
  contractId?: string | null;
  amount?: unknown;
  payDate?: Date | string | null;
  statusCode?: string | null;
}

/** 终期结算行（只需要「已出且非草稿」这个事实） */
export interface FulfillmentFinalSettlementRow {
  id: string;
  contractId?: string | null;
  statusCode?: string | null;
  settledAt?: Date | string | null;
}

export interface FulfillmentTolerances {
  /** 金额比较容差（分）；本课题主要用于「付款比例」的分母保护 */
  amount: Cents;
  /** 逾期宽限天数：计划日期过了这么多天还没完成才报 */
  graceDays: number;
  /** 完成滞后的容忍天数：实际比计划晚超过这么多天才报 */
  lateFinishDays: number;
  /** 付款比例高于完成率多少个百分点才报（C6） */
  progressGapPct: number;
}

export const DEFAULT_FULFILLMENT_TOLERANCES: FulfillmentTolerances = {
  amount: 100n,
  graceDays: 7,
  lateFinishDays: 7,
  progressGapPct: 30,
};

export interface FulfillmentInput {
  contracts: FulfillmentContractRow[];
  milestones: MilestoneRow[];
  payments?: FulfillmentPaymentRow[];
  finalSettlements?: FulfillmentFinalSettlementRow[];
  /**
   * **C7 专用补充口径**：已出终期结算的合同往往已经是「已完已结」（`execStatus=DONE_SETTLED`），
   * 因而被 C1–C6 的主口径排除在外。若 C7 也只看主口径，它的候选集恒为空——
   * 「已出终期结算却仍有未完成节点」这条规则永远是死的（2026-10-23 审计）。
   * 这里单独带上这些合同与节点，只喂给 C7。
   */
  settledScope?: { contracts: FulfillmentContractRow[]; milestones: MilestoneRow[] };
  /** 判定基准日（本地零点）；缺省用当前时间，单测必须显式传固定日期 */
  now?: Date;
  tolerances?: Partial<FulfillmentTolerances>;
}

export interface FulfillmentSummary {
  total: number;
  high: number;
  medium: number;
  byCode: Record<string, number>;
}

/** 容差合并（非法值不猜，交给上层 warning；这里只做类型收口） */
export function resolveFulfillmentTolerances(t?: Partial<FulfillmentTolerances> | null): FulfillmentTolerances {
  const base = DEFAULT_FULFILLMENT_TOLERANCES;
  if (!t) return base;
  return {
    amount: typeof t.amount === 'bigint' && t.amount >= 0n ? t.amount : base.amount,
    graceDays: Number.isInteger(t.graceDays) && (t.graceDays as number) >= 0 ? (t.graceDays as number) : base.graceDays,
    lateFinishDays:
      Number.isInteger(t.lateFinishDays) && (t.lateFinishDays as number) >= 0
        ? (t.lateFinishDays as number)
        : base.lateFinishDays,
    progressGapPct:
      Number.isInteger(t.progressGapPct) && (t.progressGapPct as number) >= 0 && (t.progressGapPct as number) <= 100
        ? (t.progressGapPct as number)
        : base.progressGapPct,
  };
}

/** 金额展示（元，两位小数），供 facts 与面板复用同一口径 */
export function yuanOf(cents: Cents): string {
  return centsToYuan(cents);
}
