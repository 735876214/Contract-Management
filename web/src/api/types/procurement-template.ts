/**
 * 采购模板域（`procurementApi`，全项目通用）。真理源：`server/src/modules/procurement/procurement-template.service.ts`。
 * 无金额字段。
 */

/** 采购模板行（`serialize`）。 */
export interface ProcurementTemplateRow {
  id: string;
  moduleType: string;
  templateName: string;
  content: string;
  variables: string[];
  tags: string | null;
  status: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** create 覆盖同类型模板时补 `true` */
  overwritten?: boolean;
}

/** 采购模板行**可能的全部键**。 */
export const PROCUREMENT_TEMPLATE_ROW_KEYS = [
  'id', 'moduleType', 'templateName', 'content', 'variables', 'tags', 'status', 'version', 'createdAt',
  'updatedAt', 'overwritten',
] as const;

/** 版本历史一项（`GET /procurement-templates/:id/versions`）。 */
export interface ProcurementTemplateVersionRow {
  id: string;
  version: number;
  templateName: string;
  operator: string | null;
  createdAt: string;
}

/** `GET /procurement-templates` 查询参数。 */
export interface ProcurementTemplateListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  moduleType?: string;
  status?: number;
}

/** `GET /procurement-templates` 列表响应。 */
export interface ProcurementTemplateListResponse {
  list: ProcurementTemplateRow[];
  total: number;
  page: number;
  pageSize: number;
}
