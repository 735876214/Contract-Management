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

export const materialApi = {
  list: (params?: any) => http.get<any, any>('/materials', { params }),
  options: (keyword?: string) => http.get<any, any>('/materials/options', { params: { keyword } }),
  create: (data: any) => http.post<any, any>('/materials', data),
  update: (id: string, data: any) => http.put<any, any>(`/materials/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/materials/${id}`),
  toggle: (id: string) => http.post<any, any>(`/materials/${id}/toggle`),
  exportUrl: () => `${http.defaults.baseURL}/materials/export`,
  templateUrl: () => `${http.defaults.baseURL}/materials/template`,
  importUrl: () => `${http.defaults.baseURL}/materials/import`,
};

export const contractMaterialApi = {
  list: (contractId: string) => http.get<any, any>('/contract-materials', { params: { contractId } }),
  // 项目下所有合同物资清单（需求修正3）：供应商/物资名称/合同编号组合筛选
  listAll: (params?: any) => http.get<any, any>('/contract-materials/all', { params }),
  derive: (contractId: string, materialIds: string[]) =>
    http.post<any, any>('/contract-materials/derive', { contractId, materialIds }),
  templateUrl: () => `${http.defaults.baseURL}/contract-materials/template`,
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
  ledgerTemplateUrl: () => `${http.defaults.baseURL}/settlements/ledger/template`,
  ledgerImportUrl: () => `${http.defaults.baseURL}/settlements/ledger/import`,
  refreshLedger: () => http.post<any, any>('/settlements/ledger/refresh'),
  ledgerImport: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post<any, any>('/settlements/ledger/import', fd);
  },
};

export const paymentApi = {
  records: (params?: any) => http.get<any, any>('/payments/records', { params }),
  createRecord: (data: any) => http.post<any, any>('/payments/records', data),
  updateRecord: (id: string, data: any) => http.put<any, any>(`/payments/records/${id}`, data),
  removeRecord: (id: string) => http.delete<any, any>(`/payments/records/${id}`),
  exportRecordsUrl: () => `${http.defaults.baseURL}/payments/records/export`,
  recordsTemplateUrl: () => `${http.defaults.baseURL}/payments/records/template`,
  recordsImportUrl: () => `${http.defaults.baseURL}/payments/records/import`,
  recordsImport: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post<any, any>('/payments/records/import', fd);
  },
};

export const invoiceApi = {
  list: (params?: any) => http.get<any, any>('/invoices', { params }),
  detail: (id: string) => http.get<any, any>(`/invoices/${id}`),
  create: (data: any) => http.post<any, any>('/invoices', data),
  update: (id: string, data: any) => http.put<any, any>(`/invoices/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/invoices/${id}`),
  checkNo: (no: string, excludeId?: string) => http.get<any, any>('/invoices/check-no', { params: { no, excludeId } }),
  verify: (id: string) => http.post<any, any>(`/invoices/${id}/verify`),
  // 批量识别：上传发票图片解码二维码 → 用户选合同后批量入台账
  recognize: (formData: FormData) => http.post<any, any[]>('/invoices/recognize', formData),
  batchCreate: (items: any[]) => http.post<any, any>('/invoices/batch', { items }),
  exportUrl: () => `${http.defaults.baseURL}/invoices/export`,
  templateUrl: () => `${http.defaults.baseURL}/invoices/template`,
  importUrl: () => `${http.defaults.baseURL}/invoices/import`,
};

export const assetApi = {
  list: (params?: any) => http.get<any, any>('/assets', { params }),
  templateUrl: () => `${http.defaults.baseURL}/assets/template`,
  import: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post<any, any>('/assets/import', fd);
  },
  create: (data: any) => http.post<any, any>('/assets', data),
  update: (id: string, data: any) => http.put<any, any>(`/assets/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/assets/${id}`),
  exportUrl: () => `${http.defaults.baseURL}/assets/export`,
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

export const financeApi = {
  // 合同资金参数（付款模式/月利率/宽限期/上限比例）
  contractParams: (contractId: string) => http.get<any, any>(`/finance/contract-params/${contractId}`),
  saveContractParams: (contractId: string, data: any) => http.put<any, any>(`/finance/contract-params/${contractId}`, data),
  // 保理费用台账
  factoring: (contractId: string) => http.get<any, any>('/finance/factoring-costs', { params: { contractId } }),
  createFactoring: (data: any) => http.post<any, any>('/finance/factoring-costs', data),
  updateFactoring: (id: string, data: any) => http.put<any, any>(`/finance/factoring-costs/${id}`, data),
  removeFactoring: (id: string) => http.delete<any, any>(`/finance/factoring-costs/${id}`),
  exportFactoringUrl: (contractId: string) => `${http.defaults.baseURL}/finance/factoring-costs/export?contractId=${contractId}`,
  // 逾期利息台账
  overdue: (contractId: string) => http.get<any, any>('/finance/overdue-interests', { params: { contractId } }),
  generateOverdue: (data: { contractId: string; settlementMonth: string; materialAmount: number }) =>
    http.post<any, any>('/finance/overdue-interests/generate', data),
  createOverdue: (data: any) => http.post<any, any>('/finance/overdue-interests', data),
  updateOverdue: (id: string, data: any) => http.put<any, any>(`/finance/overdue-interests/${id}`, data),
  removeOverdue: (id: string) => http.delete<any, any>(`/finance/overdue-interests/${id}`),
  exportOverdueUrl: (contractId: string) => `${http.defaults.baseURL}/finance/overdue-interests/export?contractId=${contractId}`,
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
