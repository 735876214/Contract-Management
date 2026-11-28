/**
 * 分包商库（主数据）域（`subcontractorApi` 在 modules.ts 的那一份）。
 * 真理源：`server/src/modules/subcontractor/subcontractor.service.ts`。
 *
 * 无金额字段——全是字符串 / Int。列表项额外带 `ledgerCount`（引用它的分包授权台账条数）。
 */

/** 分包商行（`Subcontractor`；列表项另带 ledgerCount）。 */
export interface SubcontractorRow {
  id: string;
  projectId: string | null;
  name: string;
  creditCode: string;
  legalPerson: string;
  contactName: string;
  contactPhone: string;
  remark: string;
  status: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 列表项补充：引用它的分包授权台账条数 */
  ledgerCount?: number;
}

/** 分包商行**可能的全部键**。 */
export const SUBCONTRACTOR_ROW_KEYS = [
  'id', 'projectId', 'name', 'creditCode', 'legalPerson', 'contactName', 'contactPhone', 'remark', 'status',
  'version', 'createdAt', 'updatedAt', 'ledgerCount',
] as const;

/** `GET /subcontractors/options` 一项。 */
export interface SubcontractorOption {
  id: string;
  name: string;
  legalPerson: string | null;
  contactName: string | null;
  contactPhone: string | null;
  creditCode: string | null;
}

/** `GET /subcontractors` 列表查询参数。 */
export interface SubcontractorListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: number;
}

/** `GET /subcontractors` 列表响应。 */
export interface SubcontractorListResponse {
  list: SubcontractorRow[];
  total: number;
  page: number;
  pageSize: number;
}
