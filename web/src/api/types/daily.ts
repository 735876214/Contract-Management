import type { Dateish } from './common.ts';

/**
 * 总日报域（`dailyApi`）。真理源：`server/src/modules/daily-report/daily-report.service.ts`。
 *
 * ⚠️ 列表/详情返回**原始 `DailyReport` 行**（未过 num）→ 金额/数量是 Prisma Decimal **字符串**（三态：未填 `null`）。
 * 只有 `contractSettledQty` / `unconfirmedSummary` 里的数量过了 `num()` → number。
 */

/** 日报行（raw `DailyReport` + 关联合同/供应商摘要）。金额/数量 Decimal → string。 */
export interface DailyReportRow {
  id: string;
  projectId: string;
  materialBaseId: string | null;
  periodYear: number;
  periodMonth: number;
  entryDate: Dateish;
  exitDate: Dateish;
  contractId: string | null;
  isAsset: string;
  isSafetyMaterial: string;
  assetSupervision: string;
  department: string;
  personnel: string;
  assetStatus: string;
  sourceCode: string;
  materialCategory: string;
  materialType: string;
  materialName: string;
  steelBrand: string;
  steelCount: number;
  spec: string;
  unit: string;
  /** Decimal → string */
  weighQty: string | null;
  deductQty: string | null;
  settleQty: string | null;
  isWeighed: string;
  noAcceptReason: string;
  priceBeforeTax: string | null;
  taxRatePct: string | null;
  priceAfterTax: string | null;
  amountBeforeTax: string | null;
  amountAfterTax: string | null;
  supplierId: string | null;
  receiveUnit: string;
  receiver: string;
  laborContract: string;
  usePosition: string;
  isProxy: string;
  plateNo: string;
  receiptNo: string;
  receiptOrderId: string | null;
  remark: string;
  subcontractPeriod: string;
  incomePrice: string | null;
  incomeAmount: string | null;
  stdPrice: string | null;
  stdAmount: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
  confirmStatusCode: string;
  confirmedBy: string | null;
  confirmedAt: Dateish;
  confirmRemark: string;
  /** 列表/详情补的关联摘要 */
  contract?: { id: string; code: string; name: string } | null;
  supplier?: { id: string; name: string } | null;
  [extra: string]: unknown;
}

/** 日报行**可能出现的全部键**（模型全字段 + 关联摘要）。 */
export const DAILY_REPORT_ROW_KEYS = [
  'id', 'projectId', 'materialBaseId', 'periodYear', 'periodMonth', 'entryDate', 'exitDate', 'contractId',
  'isAsset', 'isSafetyMaterial', 'assetSupervision', 'department', 'personnel', 'assetStatus', 'sourceCode',
  'materialCategory', 'materialType', 'materialName', 'steelBrand', 'steelCount', 'spec', 'unit', 'weighQty',
  'deductQty', 'settleQty', 'isWeighed', 'noAcceptReason', 'priceBeforeTax', 'taxRatePct', 'priceAfterTax',
  'amountBeforeTax', 'amountAfterTax', 'supplierId', 'receiveUnit', 'receiver', 'laborContract', 'usePosition',
  'isProxy', 'plateNo', 'receiptNo', 'receiptOrderId', 'remark', 'subcontractPeriod', 'incomePrice',
  'incomeAmount', 'stdPrice', 'stdAmount', 'createdAt', 'version', 'updatedAt', 'confirmStatusCode',
  'confirmedBy', 'confirmedAt', 'confirmRemark', 'contract', 'supplier',
] as const;

/** `GET /daily-reports` 列表查询参数。 */
export interface DailyReportListParams {
  page?: number;
  pageSize?: number;
  periodYear?: number | string;
  periodMonth?: number | string;
  contractId?: string;
  supplierId?: string;
  materialCategory?: string;
  materialType?: string;
  assetStatus?: string;
  sourceCode?: string;
  confirmStatusCode?: string;
  keyword?: string;
  startDate?: string;
  endDate?: string;
}

/** `GET /daily-reports` 列表项（行 + 关联摘要）。 */
export type DailyReportListResponse = { list: DailyReportRow[]; total: number; page: number; pageSize: number };

/** `GET /daily-reports/material-types` 一项。 */
export interface DailyMaterialType {
  value: string;
  label: string;
  extField1?: string;
}

/** `GET /daily-reports/contract-settled-qty` 一项（数量过 num → number）。 */
export interface DailyContractSettledQty {
  materialBaseId: string;
  settleQty: number;
}

/** `GET /daily-reports/unconfirmed-summary`（数量过 num → number）。 */
export interface DailyUnconfirmedSummary {
  pending: number;
  rejected: number;
  pendingQty: number;
  rejectedQty: number;
}
