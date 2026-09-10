import http from './http';

// 其余业务模块的 API 定义在 modules.ts 中，此处统一再导出，便于页面按需引入
export {
  dailyApi,
  settlementApi,
  paymentApi,
  invoiceApi,
  ledgerApi,
  repaymentApi,
  materialApi,
  notificationApi,
  dashboardApi,
} from './modules';

export const projectApi = {
  list: (params?: any) => http.get<any, any>('/projects', { params }),
  detail: (id: string) => http.get<any, any>(`/projects/${id}`),
  create: (data: any) => http.post<any, any>('/projects', data),
  update: (id: string, data: any) => http.put<any, any>(`/projects/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/projects/${id}`),
  members: (id: string) => http.get<any, any>(`/projects/${id}/members`),
  addMember: (id: string, data: { userId: string; roleCode: string }) => http.post<any, any>(`/projects/${id}/members`, data),
  removeMember: (id: string, userId: string) => http.delete<any, any>(`/projects/${id}/members/${userId}`),
  templateUrl: () => `${http.defaults.baseURL}/projects/template`,
  import: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post<any, any>('/projects/import', fd);
  },
};

export const supplierApi = {
  list: (params?: any) => http.get<any, any>('/suppliers', { params }),
  options: (keyword?: string) => http.get<any, any>('/suppliers/options', { params: { keyword } }),
  detail: (id: string) => http.get<any, any>(`/suppliers/${id}`),
  create: (data: any) => http.post<any, any>('/suppliers', data),
  update: (id: string, data: any) => http.put<any, any>(`/suppliers/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/suppliers/${id}`),
  toggle: (id: string) => http.post<any, any>(`/suppliers/${id}/toggle`),
  exportUrl: () => `${http.defaults.baseURL}/suppliers/export`,
  templateUrl: () => `${http.defaults.baseURL}/suppliers/template`,
  importUrl: () => `${http.defaults.baseURL}/suppliers/import`,
};

export const contractApi = {
  list: (params?: any) => http.get<any, any>('/contracts', { params }),
  options: (keyword?: string) => http.get<any, any>('/contracts/options', { params: { keyword } }),
  detail: (id: string) => http.get<any, any>(`/contracts/${id}`),
  create: (data: any) => http.post<any, any>('/contracts', data),
  update: (id: string, data: any) => http.put<any, any>(`/contracts/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/contracts/${id}`),
  checkCode: (code: string, excludeId?: string) =>
    http.get<any, any>('/contracts/check-code', { params: { code, excludeId } }),
  nextCode: (params: { typeCode?: string; subTypeCode?: string; projectId?: string; codeAbbr?: string }) =>
    http.get<any, any>('/contracts/next-code', { params }),
  nextSupplementCode: (id: string) => http.get<any, any>(`/contracts/${id}/next-supplement-code`),
  templateUrl: () => `${http.defaults.baseURL}/contracts/template`,
  changes: (id: string) => http.get<any, any>(`/contracts/${id}/changes`),
  ext: (id: string) => http.get<any, any>(`/contracts/${id}/ext`),
  saveExt: (id: string, data: any) => http.put<any, any>(`/contracts/${id}/ext`, data),
  importUrl: () => `${http.defaults.baseURL}/contracts/import`,
  // 合同起草（需求 2.1）
  drafts: () => http.get<any, any>('/contracts/drafts'),
  removeDraft: (id: string) => http.delete<any, any>(`/contracts/drafts/${id}`),
  // 名称预览（TMHB-CG-项目-物资-类型-供应商）
  namePreview: (params: any) => http.get<any, any>('/contracts/name-preview', { params }),
  // Tab1 物料编码清单（合同专属物资池）
  poolList: (id: string) => http.get<any, any>(`/contracts/${id}/material-pool`),
  poolAdd: (id: string, materialIds: string[]) =>
    http.post<any, any>(`/contracts/${id}/material-pool`, { materialIds }),
  poolRemove: (id: string, poolId: string) =>
    http.delete<any, any>(`/contracts/${id}/material-pool/${poolId}`),
  // Tab2 合同清单（草稿明细，从物料池派生）
  draftList: (id: string) => http.get<any, any>(`/contracts/${id}/draft-materials`),
  draftDerive: (id: string, materialBaseIds: string[]) =>
    http.post<any, any>(`/contracts/${id}/draft-materials`, { materialBaseIds }),
  draftSave: (id: string, rows: any[]) =>
    http.put<any, any>(`/contracts/${id}/draft-materials`, { rows }),
  draftRemove: (id: string, rowId: string) =>
    http.delete<any, any>(`/contracts/${id}/draft-materials/${rowId}`),
  // 状态流转：保存草稿 / 发布完成
  publish: (id: string) => http.post<any, any>(`/contracts/${id}/publish`),
  setStatus: (id: string, status: string) =>
    http.put<any, any>(`/contracts/${id}/status`, { status }),
  // 合同查询（需求 2.2）：已发布/正式合同
  published: (params?: any) => http.get<any, any>('/contracts/published', { params }),
  exportWordUrl: (id: string) => `${http.defaults.baseURL}/contracts/${id}/export-word`,
  // 合同签章（需求修正4）：上传签章文件+签订日期，状态置已签章
  sign: (id: string, fd: FormData) => http.post<any, any>(`/contracts/${id}/sign`, fd),
  signedFileUrl: (id: string) => `${http.defaults.baseURL}/contracts/${id}/signed-file`,
};

export const templateApi = {
  list: (params?: any) => http.get<any, any>('/templates', { params }),
  detail: (id: string) => http.get<any, any>(`/templates/${id}`),
  create: (data: any) => http.post<any, any>('/templates', data),
  update: (id: string, data: any) => http.put<any, any>(`/templates/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/templates/${id}`),
  toggle: (id: string) => http.post<any, any>(`/templates/${id}/toggle`),
  versions: (id: string) => http.get<any, any>(`/templates/${id}/versions`),
  rollback: (id: string, targetId: string) => http.post<any, any>(`/templates/${id}/rollback`, { targetId }),
  guideCategories: (params: any) => http.get<any, any>('/templates/guide/categories', { params }),
  generate: (data: { templateId: string; contractId: string; manual?: any }) =>
    http.post<any, any>('/templates/guide/generate', data),
  clauses: (params?: any) => http.get<any, any>('/templates/clauses', { params }),
  createClause: (data: any) => http.post<any, any>('/templates/clauses', data),
  updateClause: (id: string, data: any) => http.put<any, any>(`/templates/clauses/${id}`, data),
  removeClause: (id: string) => http.delete<any, any>(`/templates/clauses/${id}`),
};
