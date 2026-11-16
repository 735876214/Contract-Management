/**
 * 分包单位领用单据状态（与后端 `server/src/constants/statuses.ts` 的
 * `LABOR_RECEIVING_DOC_STATUS` 镜像）。
 *
 * 非字典驱动：单据只有草稿/完成两态，不提供可配置项。
 * 由 `server/test/statusCodes.spec.mts` 锁住前后端逐条相等。
 */
export const LABOR_RECEIVING_DOC_STATUS = {
  DRAFT: 'DRAFT',
  COMPLETED: 'COMPLETED',
} as const;

export type LaborReceivingDocStatus =
  (typeof LABOR_RECEIVING_DOC_STATUS)[keyof typeof LABOR_RECEIVING_DOC_STATUS];
