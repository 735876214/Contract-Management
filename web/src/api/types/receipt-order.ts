import type { Dateish } from './common.ts';

/**
 * 收领单域（`receiptOrderApi`，日报管理 → 收领单）。
 * 真理源：`server/src/modules/receipt-order/receipt-order.service.ts`。
 *
 * ⚠️ 列表/详情/创建返回**原始行** → 数量/金额是 Prisma Decimal **字符串**（三态 null）。
 * 例外：`contract-materials` 与 `subcontractor-materials` 的价格/数量过了 `num()` → **number**。
 */

/** 收领单明细行（`ReceiptOrderDetail`；金额/数量 Decimal → string）。 */
export interface ReceiptOrderDetail {
  id: string;
  orderId: string;
  materialId: string | null;
  categoryLevel1: string;
  categoryLevel2: string;
  materialName: string;
  specModel: string;
  unit: string;
  contractQty: string | null;
  deliveryQty: string | null;
  receivedQty: string | null;
  priceBeforeTax: string | null;
  taxRatePct: string | null;
  priceWithTax: string | null;
  totalPrice: string | null;
  usagePart: string;
  custodian: string;
  brand: string;
  remark: string;
  isAgentPurchase: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 收领单行（`ReceiptOrder` + 关联摘要）。 */
export interface ReceiptOrderRow {
  id: string;
  projectId: string;
  orderNo: string;
  supplierId: string | null;
  supplierName: string;
  supplierType: string;
  supplyUnitId: string | null;
  receivingUnitId: string | null;
  receivingUnitName: string;
  receivingUnitType: string;
  subcontractId: string | null;
  subcontractName: string;
  supplySubcontractId: string | null;
  supplySubcontractName: string;
  subcontractorId: string | null;
  isAssetFlag: string;
  orderDate: Dateish;
  receiver: string;
  materialContractId: string | null;
  materialContractNo: string;
  settlementId: string | null;
  status: string;
  scanUrl: string | null;
  scanFileName: string | null;
  pushedAt: Dateish;
  remark: string;
  createdBy: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
  supplier?: { id: string; name: string } | null;
  materialContract?: { id: string; code: string; name: string } | null;
  subcontract?: { id: string; code: string; name: string } | null;
  settlement?: { id: string; code: string; settleDate: string | null } | null;
  details?: ReceiptOrderDetail[];
  [extra: string]: unknown;
}

/** 收领单行**可能的全部键**（列表不带 details/subcontract）。 */
export const RECEIPT_ORDER_ROW_KEYS = [
  'id', 'projectId', 'orderNo', 'supplierId', 'supplierName', 'supplierType', 'supplyUnitId', 'receivingUnitId',
  'receivingUnitName', 'receivingUnitType', 'subcontractId', 'subcontractName', 'supplySubcontractId',
  'supplySubcontractName', 'subcontractorId', 'isAssetFlag', 'orderDate', 'receiver', 'materialContractId',
  'materialContractNo', 'settlementId', 'status', 'scanUrl', 'scanFileName', 'pushedAt', 'remark', 'createdBy',
  'createdAt', 'version', 'updatedAt', 'supplier', 'materialContract', 'subcontract', 'settlement', 'details',
] as const;

/** `GET /receipt-orders` 列表查询参数。 */
export interface ReceiptOrderListParams {
  page?: number;
  pageSize?: number;
  supplierId?: string;
  materialContractId?: string;
  status?: string;
  receiver?: string;
  keyword?: string;
  startDate?: string;
  endDate?: string;
}

/** `GET /receipt-orders` 列表响应。 */
export interface ReceiptOrderListResponse {
  list: ReceiptOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** `GET /receipt-orders/next-no`。 */
export interface ReceiptOrderNextNo {
  orderNo: string;
}

/** 收领单物资清单项（价格/数量过 num → **number**）。 */
export interface ReceiptMaterialRow {
  key: string;
  materialId: string;
  categoryLevel1: string;
  categoryLevel2: string;
  materialName: string;
  specModel: string;
  unit: string;
  contractQty: number | null;
  deliveryQty: number | null;
  receivedQty: number | null;
  priceBeforeTax: number | null;
  taxRatePct: number | null;
  priceWithTax: number | null;
  totalPrice: number | null;
  usagePart: string | null;
  brand: string | null;
  remark: string | null;
  isAgentPurchase: string | null;
  sortOrder: number;
}

/** `GET /receipt-orders/contract-materials` 响应（价格过 num → number）。 */
export interface ReceiptContractMaterialsResponse {
  contract: {
    id: string;
    code: string;
    name: string;
    supplierId: string | null;
    supplierName: string | null;
    taxRatePct: number | null;
  };
  list: ReceiptMaterialRow[];
}

/** 单据候选（供应单位/领用单位下拉项）。 */
export interface ReceiptPartyOption {
  id: string;
  name: string;
  legalPerson?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  creditCode?: string | null;
  code?: string | null;
  status?: string;
  _type: 'SUPPLIER' | 'SUBCONTRACTOR' | 'OTHER_PROJECT' | 'SELF_PROJECT';
  _label: string;
}

/** `GET /receipt-orders/party-options` 响应（4 类）。 */
export interface ReceiptPartyOptionsResponse {
  SUPPLIER: ReceiptPartyOption[];
  OTHER_PROJECT: ReceiptPartyOption[];
  SUBCONTRACTOR: ReceiptPartyOption[];
  SELF_PROJECT: ReceiptPartyOption[];
}

/** `GET /receipt-orders/receiving-unit-options` 响应（3 类）。 */
export interface ReceiptReceivingUnitOptionsResponse {
  SUBCONTRACTOR: ReceiptPartyOption[];
  SELF_PROJECT: ReceiptPartyOption[];
  OTHER_PROJECT: ReceiptPartyOption[];
}

/** 关联合同下拉项（`subcontractor-contracts` / `supplier-contracts`）。 */
export interface ReceiptContractOption {
  id: string;
  code: string;
  name: string;
  typeCode: string;
  supplierId: string | null;
}

/** `GET /receipt-orders/subcontractor-materials` 响应（价格过 num → number）。 */
export interface ReceiptSubcontractorMaterialsResponse {
  list: ReceiptMaterialRow[];
}
