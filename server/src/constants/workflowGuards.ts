import { BadRequestException } from '@nestjs/common';

/**
 * 任务 7：三处「驳回」（无审批流，纯状态回退）的状态机守卫 —— 单一事实源。
 * 供 service 与单测共用，避免驳回规则散落在各 service 中逐渐漂移。
 * - 合同签章驳回 → 回到「合同起草」
 * - 结算驳回 → 回到「回填（草稿）」
 * - 成交报告退回 → 回到「重发（成交报告编制中）」
 */

/** 合同状态（与 contract.service 保持一致：DRAFT 草稿中 / APPROVING 审批中 / SIGNED 已签章） */
export const CONTRACT_STATUS = {
  DRAFT: 'DRAFT',
  APPROVING: 'APPROVING',
  SIGNED: 'SIGNED',
} as const;

/** 可被驳回回「合同起草」的合同状态：仅「审批中 / 已签章」（草稿本就处于起草，无需驳回） */
export const CONTRACT_REJECTABLE_STATUSES: readonly string[] = [
  CONTRACT_STATUS.APPROVING,
  CONTRACT_STATUS.SIGNED,
];

/** 结算状态（与 settlement_status 字典项一致） */
export const SETTLEMENT_STATUS = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  INVOICED: 'INVOICED',
  PAID: 'PAID',
  DONE: 'DONE',
} as const;

/** 可被驳回回「回填」的结算状态：已提交（待确认及之后）；草稿无需驳回 */
export const SETTLEMENT_REJECTABLE_STATUSES: readonly string[] = [
  SETTLEMENT_STATUS.PENDING,
  SETTLEMENT_STATUS.CONFIRMED,
  SETTLEMENT_STATUS.INVOICED,
  SETTLEMENT_STATUS.PAID,
  SETTLEMENT_STATUS.DONE,
];

/** 合同签章驳回 → 合同起草：仅「审批中 / 已签章」可驳回 */
export function assertContractRejectable(status: string): void {
  if (!CONTRACT_REJECTABLE_STATUSES.includes(String(status ?? ''))) {
    throw new BadRequestException('仅「审批中 / 已签章」的合同可驳回回合同起草');
  }
}

/** 结算驳回 → 回填：仅已提交（待确认/已确认/已开票/已付款/已完成）可驳回，草稿不可重复驳回 */
export function assertSettlementRejectable(statusCode: string): void {
  if (!SETTLEMENT_REJECTABLE_STATUSES.includes(String(statusCode ?? ''))) {
    throw new BadRequestException('仅已提交（待确认及之后）的结算单可驳回回填，草稿无需驳回');
  }
}

/** 成交报告退回 → 重发 的判定入参 */
export interface ResultReportRejectContext {
  type: string;
  stage: number;
  /** 成交报告阶段在阶段链中的下标（由 stageChain 推导，勿硬编码） */
  reportStageIndex: number;
  /** 已自动生成的关联合同状态；无关联合同（或未生成）传 null/undefined */
  linkedContractStatus?: string | null;
}

/**
 * 成交报告退回 → 重发：
 * - 仅「单项采购」有成交报告阶段；
 * - 成交报告须已发布（stage >= 成交报告下标）；
 * - 若下游合同已签章/审批中，禁止退回（需先驳回合同回到合同起草），避免产生孤儿合同。
 */
export function assertResultReportRejectable(ctx: ResultReportRejectContext): void {
  if (ctx.type !== 'SINGLE') {
    throw new BadRequestException('仅「单项采购」类型的采购任务可退回成交报告');
  }
  if (ctx.stage < ctx.reportStageIndex) {
    throw new BadRequestException('成交报告尚未发布，无需退回');
  }
  if (ctx.linkedContractStatus && ctx.linkedContractStatus !== CONTRACT_STATUS.DRAFT) {
    throw new BadRequestException('下游合同已签章/审批中，无法退回成交报告，请先驳回合同回到合同起草');
  }
}
