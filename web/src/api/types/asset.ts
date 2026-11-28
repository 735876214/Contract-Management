import type { Dateish } from './common.ts';

/**
 * 资产域（`assetApi`：资产卡片列表 + 物资进出场汇总）。
 * 真理源：`server/src/modules/asset/asset.service.ts`、`asset-flow.ts`。
 *
 * ⚠️ `list` 返回**原始 `AssetLedger` 行** → 数量/金额是 Decimal **字符串**（三态 null）。
 * `flowSummary` 聚合值过 `num()`/round → **number**。
 */

/** 资产台账行（raw `AssetLedger` + supplier 摘要；数量/金额 Decimal → string）。 */
export interface AssetLedgerRow {
  id: string;
  projectId: string;
  date: Dateish;
  sourceCode: string;
  categoryL1Code: string;
  categoryFocusCode: string;
  name: string;
  spec: string;
  unit: string;
  qty: string | null;
  price: string | null;
  totalAmount: string | null;
  supplierId: string | null;
  receiveUnit: string;
  responsible: string;
  inUseQty: string | null;
  idleQty: string | null;
  scrapQty: string | null;
  lostQty: string | null;
  inUseAmount: string | null;
  idleAmount: string | null;
  scrapAmount: string | null;
  lostAmount: string | null;
  remark: string;
  turnoverCount: number;
  originalPrice: string | null;
  originalTotal: string | null;
  transferOutPrice: string | null;
  transferOutAmount: string | null;
  receiptOrderId: string | null;
  receiptDetailId: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
  supplier?: { name: string } | null;
  [extra: string]: unknown;
}

/** 资产台账行**可能的全部键**。 */
export const ASSET_LEDGER_ROW_KEYS = [
  'id', 'projectId', 'date', 'sourceCode', 'categoryL1Code', 'categoryFocusCode', 'name', 'spec', 'unit', 'qty',
  'price', 'totalAmount', 'supplierId', 'receiveUnit', 'responsible', 'inUseQty', 'idleQty', 'scrapQty', 'lostQty',
  'inUseAmount', 'idleAmount', 'scrapAmount', 'lostAmount', 'remark', 'turnoverCount', 'originalPrice',
  'originalTotal', 'transferOutPrice', 'transferOutAmount', 'receiptOrderId', 'receiptDetailId', 'createdAt',
  'version', 'updatedAt', 'supplier',
] as const;

/** `GET /assets` 列表查询参数。 */
export interface AssetListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  sourceCode?: string;
  direction?: string;
  categoryL1Code?: string;
  categoryFocusCode?: string;
}

/** `GET /assets` 列表响应。 */
export interface AssetListResponse {
  list: AssetLedgerRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** `GET /assets/flow-summary`（聚合值 number|null）。 */
export interface AssetFlowSummary {
  inQty: number | null;
  inAmount: number | null;
  outQty: number | null;
  outAmount: number | null;
  feeAmount: number | null;
  unknownQty: number | null;
  unknownAmount: number | null;
  bySource: Array<{
    sourceCode: string;
    direction: 'IN' | 'OUT' | 'FEE' | 'UNKNOWN';
    qty: number | null;
    amount: number | null;
  }>;
  startDate: string | null;
  endDate: string | null;
}
