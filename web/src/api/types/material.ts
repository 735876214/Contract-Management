/**
 * 物资基础库 + 合同物资清单域（`materialApi` + `contractMaterialApi`）。
 * 真理源：`server/src/modules/material/material.service.ts`。
 */

/** 物资基础库行（`MaterialBase`；列表项另带 refCount）。无金额字段。 */
export interface MaterialBaseRow {
  id: string;
  name: string;
  spec: string;
  categoryLevel1: string;
  categoryLevel2: string;
  mdmCode: string;
  dscCode: string;
  unit: string;
  isAsset: boolean;
  isSafetyMaterial: boolean;
  status: number;
  remark: string;
  createdAt: string;
  version: number;
  updatedAt: string;
  /** 列表项补充：被引用的合同物资条数 */
  refCount?: number;
}

/** 物资基础库行**可能的全部键**。 */
export const MATERIAL_BASE_ROW_KEYS = [
  'id', 'name', 'spec', 'categoryLevel1', 'categoryLevel2', 'mdmCode', 'dscCode', 'unit', 'isAsset',
  'isSafetyMaterial', 'status', 'remark', 'createdAt', 'version', 'updatedAt', 'refCount',
] as const;

/** `GET /materials` 查询参数。 */
export interface MaterialListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: number;
  categoryLevel1?: string;
  categoryLevel2?: string;
}

/** `GET /materials` 列表响应。 */
export interface MaterialListResponse {
  list: MaterialBaseRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 合同物资清单行（raw `ContractMaterial` + materialBase；金额 Decimal → string）。
 */
export interface ContractMaterialRow {
  id: string;
  contractId: string;
  materialBaseId: string;
  unit: string;
  qty: string | null;
  priceBeforeTax: string | null;
  taxRatePct: string | null;
  priceWithTax: string | null;
  totalWithTax: string | null;
  remark: string;
  incomePrice: string | null;
  incomeTotal: string | null;
  stdPrice: string | null;
  stdTotal: string | null;
  sortOrder: number;
  createdAt: string;
  version: number;
  updatedAt: string;
  materialBase?: MaterialBaseRow | null;
  [extra: string]: unknown;
}

/** 合同物资清单行**可能的全部键**。 */
export const CONTRACT_MATERIAL_ROW_KEYS = [
  'id', 'contractId', 'materialBaseId', 'unit', 'qty', 'priceBeforeTax', 'taxRatePct', 'priceWithTax',
  'totalWithTax', 'remark', 'incomePrice', 'incomeTotal', 'stdPrice', 'stdTotal', 'sortOrder', 'createdAt',
  'version', 'updatedAt', 'materialBase',
] as const;

/** `GET /contract-materials` 响应（非分页：合同头 + 清单）。 */
export interface ContractMaterialListResponse {
  contract: {
    id: string;
    code: string;
    name: string;
    supplierName: string;
    projectName: string;
    industryType: string;
    signDate: string | null;
  };
  list: ContractMaterialRow[];
}

/** `GET /contract-materials/all` 查询参数。 */
export interface ContractMaterialAllParams {
  page?: number;
  pageSize?: number;
  contractId?: string;
  supplierName?: string;
  materialName?: string;
  contractCode?: string;
}

/** `GET /contract-materials/all` 列表响应（行另带 contract 摘要）。 */
export interface ContractMaterialAllResponse {
  list: Array<ContractMaterialRow & { contract?: { id: string; code: string; name: string } | null }>;
  total: number;
  page: number;
  pageSize: number;
}
