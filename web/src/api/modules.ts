import http from './http';

export const dailyApi = {
  list: (params?: any) => http.get<any, any>('/daily-reports', { params }),
  detail: (id: string) => http.get<any, any>(`/daily-reports/${id}`),
  create: (data: any) => http.post<any, any>('/daily-reports', data),
  update: (id: string, data: any) => http.put<any, any>(`/daily-reports/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/daily-reports/${id}`),
  materialTypes: (category: string) => http.get<any, any>('/daily-reports/material-types', { params: { category } }),
  exportUrl: () => `${http.defaults.baseURL}/daily-reports/export`,
  importUrl: () => `${http.defaults.baseURL}/daily-reports/import`,
};

export const itemApi = {
  list: (params?: any) => http.get<any, any>('/contract-items', { params }),
  detail: (id: string) => http.get<any, any>(`/contract-items/${id}`),
  create: (data: any) => http.post<any, any>('/contract-items', data),
  update: (id: string, data: any) => http.put<any, any>(`/contract-items/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/contract-items/${id}`),
  generate: (contractId: string) => http.post<any, any>(`/contract-items/generate/${contractId}`),
  exportUrl: () => `${http.defaults.baseURL}/contract-items/export`,
  importUrl: () => `${http.defaults.baseURL}/contract-items/import`,
};

export const materialApi = {
  list: (params?: any) => http.get<any, any>('/materials', { params }),
  options: (keyword?: string) => http.get<any, any>('/materials/options', { params: { keyword } }),
  create: (data: any) => http.post<any, any>('/materials', data),
  update: (id: string, data: any) => http.put<any, any>(`/materials/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/materials/${id}`),
  toggle: (id: string) => http.post<any, any>(`/materials/${id}/toggle`),
  exportUrl: () => `${http.defaults.baseURL}/materials/export`,
  importUrl: () => `${http.defaults.baseURL}/materials/import`,
};

export const contractMaterialApi = {
  list: (contractId: string) => http.get<any, any>('/contract-materials', { params: { contractId } }),
  create: (data: any) => http.post<any, any>('/contract-materials', data),
  update: (id: string, data: any) => http.put<any, any>(`/contract-materials/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/contract-materials/${id}`),
  sort: (items: { id: string; sortOrder: number }[]) => http.put<any, any>('/contract-materials/sort', { items }),
  exportUrl: (contractId: string, format: 'xlsx' | 'csv' = 'xlsx') =>
    `${http.defaults.baseURL}/contract-materials/export?contractId=${contractId}&format=${format}`,
  importUrl: (contractId: string) => `${http.defaults.baseURL}/contract-materials/import?contractId=${contractId}`,
};

export const settlementApi = {
  list: (params?: any) => http.get<any, any>('/settlements', { params }),
  detail: (id: string) => http.get<any, any>(`/settlements/${id}`),
  create: (data: any) => http.post<any, any>('/settlements', data),
  update: (id: string, data: any) => http.put<any, any>(`/settlements/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/settlements/${id}`),
  ledger: (params?: any) => http.get<any, any>('/settlements/ledger', { params }),
  ledgerDetail: (id: string) => http.get<any, any>(`/settlements/ledger/${id}`),
  createLedger: (data: any) => http.post<any, any>('/settlements/ledger', data),
  updateLedger: (id: string, data: any) => http.put<any, any>(`/settlements/ledger/${id}`, data),
  removeLedger: (id: string) => http.delete<any, any>(`/settlements/ledger/${id}`),
  exportLedgerUrl: () => `${http.defaults.baseURL}/settlements/ledger/export`,
};

export const paymentApi = {
  plans: (params?: any) => http.get<any, any>('/payments/plans', { params }),
  createPlan: (data: any) => http.post<any, any>('/payments/plans', data),
  updatePlan: (id: string, data: any) => http.put<any, any>(`/payments/plans/${id}`, data),
  removePlan: (id: string) => http.delete<any, any>(`/payments/plans/${id}`),
  generatePlans: (data: any) => http.post<any, any>('/payments/plans/generate', data),
  applies: (params?: any) => http.get<any, any>('/payments/applies', { params }),
  createApply: (data: any) => http.post<any, any>('/payments/applies', data),
  updateApply: (id: string, data: any) => http.put<any, any>(`/payments/applies/${id}`, data),
  removeApply: (id: string) => http.delete<any, any>(`/payments/applies/${id}`),
  records: (params?: any) => http.get<any, any>('/payments/records', { params }),
  createRecord: (data: any) => http.post<any, any>('/payments/records', data),
  updateRecord: (id: string, data: any) => http.put<any, any>(`/payments/records/${id}`, data),
  removeRecord: (id: string) => http.delete<any, any>(`/payments/records/${id}`),
  verifications: () => http.get<any, any>('/payments/verifications'),
  overdue: () => http.get<any, any>('/payments/overdue'),
  exportRecordsUrl: () => `${http.defaults.baseURL}/payments/records/export`,
};

export const invoiceApi = {
  list: (params?: any) => http.get<any, any>('/invoices', { params }),
  detail: (id: string) => http.get<any, any>(`/invoices/${id}`),
  create: (data: any) => http.post<any, any>('/invoices', data),
  update: (id: string, data: any) => http.put<any, any>(`/invoices/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/invoices/${id}`),
  checkNo: (no: string, excludeId?: string) => http.get<any, any>('/invoices/check-no', { params: { no, excludeId } }),
  verify: (id: string) => http.post<any, any>(`/invoices/${id}/verify`),
  applies: (params?: any) => http.get<any, any>('/invoices/applies', { params }),
  createApply: (data: any) => http.post<any, any>('/invoices/applies', data),
  removeApply: (id: string) => http.delete<any, any>(`/invoices/applies/${id}`),
  exportUrl: () => `${http.defaults.baseURL}/invoices/export`,
  importUrl: () => `${http.defaults.baseURL}/invoices/import`,
};

export const ledgerApi = {
  contracts: (params?: any) => http.get<any, any>('/ledger/contracts', { params }),
  columns: () => http.get<any, any>('/ledger/columns'),
  saveColumns: (config: Record<string, boolean>) => http.put<any, any>('/ledger/columns', config),
  summary: () => http.get<any, any>('/ledger/summary'),
  exportUrl: () => `${http.defaults.baseURL}/ledger/export`,
};

export const repaymentApi = {
  list: (params?: any) => http.get<any, any>('/repayments', { params }),
  detail: (id: string) => http.get<any, any>(`/repayments/${id}`),
  create: (data: any) => http.post<any, any>('/repayments', data),
  update: (id: string, data: any) => http.put<any, any>(`/repayments/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/repayments/${id}`),
  suggestCode: () => http.get<any, any>('/repayments/suggest-code'),
  checkCode: (code: string, excludeId?: string) => http.get<any, any>('/repayments/check-code', { params: { code, excludeId } }),
  exportUrl: () => `${http.defaults.baseURL}/repayments/export`,
};

export const notificationApi = {
  list: (params?: any) => http.get<any, any>('/notifications', { params }),
  unreadCount: () => http.get<any, any>('/notifications/unread-count'),
  read: (id: string) => http.post<any, any>(`/notifications/${id}/read`),
  readAll: () => http.post<any, any>('/notifications/read-all'),
};

export const dashboardApi = {
  overview: () => http.get<any, any>('/dashboard/overview'),
  trend: () => http.get<any, any>('/dashboard/trend'),
  contractType: () => http.get<any, any>('/dashboard/contract-type'),
  invoiceStats: () => http.get<any, any>('/dashboard/invoice-stats'),
  reminders: () => http.get<any, any>('/dashboard/reminders'),
};
