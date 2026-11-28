/**
 * 成本管理域（`costApi`：月度盈亏分析 + 分包单位领用单据）。
 * 真理源：`server/src/modules/cost/monthly-profit-loss.service.ts`、`labor-receiving.service.ts`。
 *
 * ✅ 本域金额/数量在服务端用 `Number(...)` / 派生原语算过 → JSON **number**（或 null，三态）。
 */

/** 月度盈亏分析列表行（`serializeHeader`；金额 number|null）。 */
export interface CostMonthlyProfitLossRow {
  id: string;
  period: string;
  sixSavingsAmount: number | null;
  totalDeductAmount: number | null;
  remark: string;
  detailCount?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 月度盈亏明细行（`serializeDetail`；全部 number|null）。 */
export interface CostMonthlyProfitLossDetail {
  id: string;
  sortOrder: number;
  subcontractorId: string | null;
  laborTeamName: string;
  owner: string;
  materialName: string;
  spec: string;
  unit: string;
  unitPrice: number | null;
  entryQty: number | null;
  designQty: number | null;
  lossRate: number | null;
  theoryUseQty: number | null;
  actualUseQty: number | null;
  stockQty: number | null;
  saveOverQty: number | null;
  saveOverAmount: number | null;
  saveRate: number | null;
  deductAmount: number | null;
  remark: string;
}

/** `GET /cost/monthly-profit-loss/:id` 详情（头 + details）。 */
export interface CostMonthlyProfitLossDetailResponse extends CostMonthlyProfitLossRow {
  details: CostMonthlyProfitLossDetail[];
}

/** 月度盈亏列表行**可能的全部键**。 */
export const COST_MONTHLY_PL_ROW_KEYS = [
  'id', 'period', 'sixSavingsAmount', 'totalDeductAmount', 'remark', 'detailCount', 'version', 'createdAt',
  'updatedAt',
] as const;

/** `GET /cost/monthly-profit-loss` 查询参数。 */
export interface CostMonthlyProfitLossListParams {
  page?: number;
  pageSize?: number;
  period?: string;
}

/** 月度盈亏列表响应。 */
export interface CostMonthlyProfitLossListResponse {
  list: CostMonthlyProfitLossRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** `GET /cost/labor-receiving/options`。 */
export interface CostLaborReceivingOptions {
  subcontractors: Array<{ id: string; name: string }>;
  periods: string[];
}

/** 分包单位领用单据列表行（`serializeDoc`；金额 number|null）。 */
export interface CostLaborReceivingDocRow {
  id: string;
  docNo: string;
  subcontractorId: string;
  subcontractorName: string;
  period: string;
  contractName: string;
  status: string;
  remark: string;
  detailCount?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 分包单位领用单据明细行（`buildRows` + 派生；全部 number|null）。 */
export interface CostLaborReceivingItem {
  key: string;
  sort: number;
  id: string | null;
  version: number;
  prevCum: number;
  materialName: string;
  spec: string;
  unit: string | null;
  receivedQty: number | null;
  unitPrice: number | null;
  designQtyCum: number | null;
  lossRate: number | null;
  returnQty: number | null;
  stockTakeQty: number | null;
  remark: string;
  netQty: number | null;
  usedCum: number | null;
  actualUse: number | null;
  deductPrice: number | null;
  designSubtotal: number | null;
  saveOver: number | null;
  deductAmount: number | null;
  actualLossRate: number | null;
}

/** `GET /cost/labor-receiving/docs/:id` 详情（头 + details）。 */
export interface CostLaborReceivingDocDetail extends CostLaborReceivingDocRow {
  details: CostLaborReceivingItem[];
}

/** 领用单据列表行**可能的全部键**。 */
export const COST_LABOR_RECEIVING_DOC_ROW_KEYS = [
  'id', 'docNo', 'subcontractorId', 'subcontractorName', 'period', 'contractName', 'status', 'remark',
  'detailCount', 'version', 'createdAt', 'updatedAt',
] as const;

/** `GET /cost/labor-receiving/docs` 查询参数。 */
export interface CostLaborReceivingDocListParams {
  page?: number;
  pageSize?: number;
  period?: string;
  status?: string;
  keyword?: string;
}

/** 领用单据列表响应。 */
export interface CostLaborReceivingDocListResponse {
  list: CostLaborReceivingDocRow[];
  total: number;
  page: number;
  pageSize: number;
}
