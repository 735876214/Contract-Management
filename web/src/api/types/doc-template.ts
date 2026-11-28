/**
 * 单据模板域（`docTemplateApi`，基础信息管理 → 五类单据 Excel 模板）。
 * 真理源：`server/src/modules/doc-template/doc-template.service.ts`。
 *
 * ⚠️ `GET /doc-templates` 返回**裸数组**（无分页信封）。无金额字段。
 */

/** 单据模板行（`ContractTemplate`，限五类单据目录）。 */
export interface DocTemplateRow {
  id: string;
  name: string;
  categoryCode: string;
  tags: string | null;
  status: number;
  version: number;
  content: string;
  fileUrl: string | null;
  fileName: string | null;
  pageSetup: string | null;
  projectId: string | null;
  parentId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 单据模板行**可能的全部键**。 */
export const DOC_TEMPLATE_ROW_KEYS = [
  'id', 'name', 'categoryCode', 'tags', 'status', 'version', 'content', 'fileUrl', 'fileName', 'pageSetup',
  'projectId', 'parentId', 'createdBy', 'createdAt', 'updatedAt',
] as const;

/** `GET /doc-templates` 查询参数。 */
export interface DocTemplateListParams {
  categoryCode?: string;
  keyword?: string;
  status?: 0 | 1 | string;
}
