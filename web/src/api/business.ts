import http from './http';

// 其余业务模块的 API 定义在 modules.ts 中，此处统一再导出，便于页面按需引入
export {
  dailyApi,
  itemApi,
  settlementApi,
  paymentApi,
  invoiceApi,
  ledgerApi,
  repaymentApi,
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
  changes: (id: string) => http.get<any, any>(`/contracts/${id}/changes`),
  ext: (id: string) => http.get<any, any>(`/contracts/${id}/ext`),
  saveExt: (id: string, data: any) => http.put<any, any>(`/contracts/${id}/ext`, data),
  exportUrl: () => `${http.defaults.baseURL}/contracts/export`,
  importUrl: () => `${http.defaults.baseURL}/contracts/import`,
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
