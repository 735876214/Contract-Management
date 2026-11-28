import type { Dateish } from './common.ts';

/**
 * 还款协议域（`repaymentApi`）。真理源：`server/src/modules/repayment/repayment.service.ts`。
 *
 * ⚠️ 列表/详情返回原始 `RepaymentAgreement`（+ details）→ 金额 Decimal **字符串**（三态 null）。
 */

/** 还款明细行（`RepaymentDetail`；amount 是 Decimal → string）。 */
export interface RepaymentDetail {
  id: string;
  agreementId: string;
  period: number;
  /** Decimal → string */
  amount: string | null;
  dueDate: Dateish;
  remark: string;
  createdAt: string;
}

/** 还款协议行（`RepaymentAgreement`；金额 Decimal → string）。 */
export interface RepaymentAgreementRow {
  id: string;
  projectId: string;
  code: string;
  supplierId: string | null;
  contractId: string | null;
  material: string;
  signDate: Dateish;
  settleAmount: string | null;
  agreedDebtAmount: string | null;
  paidBeforeSign: string | null;
  paidAfterSign: string | null;
  overdueUnpaid: string | null;
  remark: string;
  createdAt: string;
  version: number;
  updatedAt: string;
  supplier?: { id: string; name: string; contactName: string | null; contactPhone: string | null } | null;
  contract?: { id: string; code: string; name: string } | null;
  details?: RepaymentDetail[];
  [extra: string]: unknown;
}

/** 还款协议行**可能出现的全部键**。 */
export const REPAYMENT_ROW_KEYS = [
  'id', 'projectId', 'code', 'supplierId', 'contractId', 'material', 'signDate', 'settleAmount',
  'agreedDebtAmount', 'paidBeforeSign', 'paidAfterSign', 'overdueUnpaid', 'remark', 'createdAt', 'version',
  'updatedAt', 'supplier', 'contract', 'details',
] as const;

/** `GET /repayments` 列表查询参数。 */
export interface RepaymentListParams {
  page?: number;
  pageSize?: number;
  code?: string;
  supplierId?: string;
  contractId?: string;
  startDate?: string;
  endDate?: string;
  keyword?: string;
}

/** `GET /repayments` 列表响应。 */
export interface RepaymentListResponse {
  list: RepaymentAgreementRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** `GET /repayments/suggest-code`。 */
export interface RepaymentSuggestCode {
  code: string;
}

/** `GET /repayments/check-code`。 */
export interface RepaymentCheckCode {
  exists: boolean;
}
