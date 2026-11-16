/**
 * 合同履约节点的纯逻辑（四域扩展按需项 2026-10-18）。
 *
 * 「逾期」是**派生值**，不落库：节点未完成（非 DONE/SKIPPED）且计划日期已过 → 逾期。
 * 零依赖，供 `.mts` 单测直接加载（`server/test/milestone.spec.mts`）。
 */

import { MILESTONE_STATUS } from '../../constants/statuses.ts';

export interface MilestoneLike {
  planDate?: Date | string | null;
  statusCode?: string | null;
}

/** 当天零点（本地时区）；`now` 参数供测试注入 */
export function startOfToday(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 节点是否逾期：有计划日期、状态未完成、计划日期早于今天（当天到期不算逾期） */
export function isMilestoneOverdue(m: MilestoneLike, now: Date = new Date()): boolean {
  if (!m.planDate) return false;
  if (m.statusCode === MILESTONE_STATUS.DONE || m.statusCode === MILESTONE_STATUS.SKIPPED) return false;
  const plan = m.planDate instanceof Date ? m.planDate : new Date(m.planDate);
  if (isNaN(plan.getTime())) return false;
  return plan.getTime() < startOfToday(now).getTime();
}

/** 展示层状态映射（前端 Timeline 颜色；语义色名，不写死 hex） */
export const MILESTONE_STATUS_COLORS: Record<string, string> = {
  [MILESTONE_STATUS.PENDING]: 'blue',
  [MILESTONE_STATUS.DONE]: 'green',
  [MILESTONE_STATUS.SKIPPED]: 'default',
};

/** 状态展示名 */
export const MILESTONE_STATUS_LABELS: Record<string, string> = {
  [MILESTONE_STATUS.PENDING]: '未完成',
  [MILESTONE_STATUS.DONE]: '已完成',
  [MILESTONE_STATUS.SKIPPED]: '已跳过',
};
