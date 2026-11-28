import type { Dateish } from './common.ts';

/**
 * 劳务管理 · 分包授权台账域（`laborApi`）。真理源：`server/src/modules/labor/labor.service.ts`。
 * 无金额字段——字符串 / 日期 / Int。
 */

/** 分包授权台账行（`LaborAuthLedger`）。 */
export interface LaborAuthLedgerRow {
  id: string;
  projectId: string;
  subcontractorId: string | null;
  subcontractorName: string;
  subcontractContent: string;
  subcontractId: string | null;
  legalPerson: string;
  authorizedPerson: string;
  authorizedPersonIdNo: string;
  projectName: string;
  idCardFront: string | null;
  idCardBack: string | null;
  signatureScreenshot: string | null;
  signedAuthFile: string | null;
  authStartDate: Dateish;
  authEndDate: Dateish;
  status: string;
  remark: string;
  createdBy: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
}

/** 分包授权台账行**可能的全部键**。 */
export const LABOR_AUTH_LEDGER_ROW_KEYS = [
  'id', 'projectId', 'subcontractorId', 'subcontractorName', 'subcontractContent', 'subcontractId', 'legalPerson',
  'authorizedPerson', 'authorizedPersonIdNo', 'projectName', 'idCardFront', 'idCardBack', 'signatureScreenshot',
  'signedAuthFile', 'authStartDate', 'authEndDate', 'status', 'remark', 'createdBy', 'createdAt', 'version',
  'updatedAt',
] as const;

/** `GET /labor/auth-ledger` 列表查询参数。 */
export interface LaborAuthLedgerListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  keyword?: string;
}

/** `GET /labor/auth-ledger` 列表响应。 */
export interface LaborAuthLedgerListResponse {
  list: LaborAuthLedgerRow[];
  total: number;
  page: number;
  pageSize: number;
}
