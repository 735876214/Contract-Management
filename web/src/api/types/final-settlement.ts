import type { Dateish } from './common.ts';

/**
 * 总结算单域（`finalSettlementApi`）。真理源：`server/src/modules/final-settlement/final-settlement.service.ts`。
 *
 * ⚠️ 列表/详情返回原始 `FinalSettlement`（+ items）→ 金额 Decimal **字符串**（三态 null）。
 */

/** 总结算明细行（`FinalSettlementItem`；amount Decimal → string）。 */
export interface FinalSettlementItem {
  id: string;
  finalSettlementId: string;
  settleMonth: string;
  /** Decimal → string */
  amount: string | null;
  settlementId: string | null;
  sortOrder: number;
  createdAt: string;
}

/** 总结算单行（`FinalSettlement`；totalAmount/reduceAmount Decimal → string）。 */
export interface FinalSettlementRow {
  id: string;
  projectId: string;
  contractId: string;
  code: string;
  statusCode: string;
  settledAt: Dateish;
  /** Decimal → string */
  totalAmount: string | null;
  /** Decimal → string（默认 0，恒存在） */
  reduceAmount: string;
  docNumber: string;
  attachmentUrl: string;
  attachmentName: string;
  remark: string;
  createdBy: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
  contract?: { id: string; code: string; name: string; execStatus: string } | null;
  items?: FinalSettlementItem[];
  [extra: string]: unknown;
}

/** 总结算单行**可能的全部键**。 */
export const FINAL_SETTLEMENT_ROW_KEYS = [
  'id', 'projectId', 'contractId', 'code', 'statusCode', 'settledAt', 'totalAmount', 'reduceAmount',
  'docNumber', 'attachmentUrl', 'attachmentName', 'remark', 'createdBy', 'createdAt', 'version', 'updatedAt',
  'contract', 'items',
] as const;

/** `GET /final-settlements` 列表查询参数。 */
export interface FinalSettlementListParams {
  page?: number;
  pageSize?: number;
  contractId?: string;
  statusCode?: string;
  keyword?: string;
}

/** `GET /final-settlements` 列表响应。 */
export interface FinalSettlementListResponse {
  list: FinalSettlementRow[];
  total: number;
  page: number;
  pageSize: number;
}
