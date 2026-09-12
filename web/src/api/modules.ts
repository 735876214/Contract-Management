import http from './http';

/** 采购模板（批次一 · 任务 1.2）：每个业务类型仅一个模板，新增覆盖同类型旧模板 */
export const procurementApi = {
  list: () => http.get<any, any>('/procurement-templates'),
  detail: (id: string) => http.get<any, any>(`/procurement-templates/${id}`),
  // 同业务类型已有模板时后端执行覆盖（upsert），前端负责覆盖前确认
  create: (data: { moduleType: string; templateName: string; content: string; variables?: string[] }) =>
    http.post<any, any>('/procurement-templates', data),
  update: (id: string, data: { moduleType?: string; templateName?: string; content?: string; variables?: string[] }) =>
    http.put<any, any>(`/procurement-templates/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/procurement-templates/${id}`),
};

/**
 * 采购任务（批次二 · 任务 2.1 采购发起 + 工作流状态管理）
 * 阶段链前置约束：前一任务未发布时后续任务禁用（编辑/发布均由后端校验）。
 */
export const procurementTaskApi = {
  list: (params?: any) => http.get<any, any>('/procurement-tasks', { params }),
  detail: (id: string) => http.get<any, any>(`/procurement-tasks/${id}`),
  create: (data: {
    type: string;
    content: string;
    purpose?: string;
    preMeetingRequired?: boolean;
    procurementCategory?: string;
  }) => http.post<any, any>('/procurement-tasks', data),
  update: (
    id: string,
    data: {
      content?: string;
      purpose?: string;
      preMeetingRequired?: boolean;
      procurementCategory?: string;
      techQuality?: string;
      acceptanceMethod?: string;
      paymentMethod?: string;
    },
  ) => http.put<any, any>(`/procurement-tasks/${id}`, data),
  /** 发布当前阶段子任务，状态自动流转到下一阶段「编制中」 */
  publish: (id: string) => http.post<any, any>(`/procurement-tasks/${id}/publish`),
  /** 合同阶段状态同步（生成合同/合同状态变化后调用） */
  syncContractStatus: (id: string) => http.post<any, any>(`/procurement-tasks/${id}/sync-contract-status`),
  /** 总采购清单（任务 2.2）：frozen=true 表示已发布冻结 */
  totalList: (id: string) => http.get<any, any>(`/procurement-tasks/${id}/total-list`),
  /** 保存总采购清单（全量替换；服务端校验基础库/字典/控制价并同步计量单位到基础库） */
  saveTotalList: (id: string, items: unknown[]) =>
    http.put<any, any>(`/procurement-tasks/${id}/total-list`, { items }),
  /** 框架协议事前说明（任务 3.1）：仅 FRAMEWORK 类型任务可用 */
  frameworkExplanation: (id: string) =>
    http.get<any, any>(`/procurement-tasks/${id}/framework-explanation`),
  saveFrameworkExplanation: (
    id: string,
    data: {
      frameworkIntro?: string;
      negotiation?: string;
      inquiryRows?: unknown[];
      priceCompareRows?: unknown[];
      execution?: string;
      costRows?: unknown[];
      attachments?: unknown[];
    },
  ) => http.put<any, any>(`/procurement-tasks/${id}/framework-explanation`, data),
  /** 采前会会议纪要（任务 3.2）：仅「单项采购」且预计采购金额 ≥ 100 万时生成 */
  preMeetingMinutes: (id: string) =>
    http.get<any, any>(`/procurement-tasks/${id}/pre-meeting-minutes`),
  savePreMeetingMinutes: (
    id: string,
    data: {
      meetingTime?: string | null;
      content?: string;
      host?: string;
      attendees?: string;
      writer?: string;
      reviewer?: string;
      purchaseItems?: unknown[];
      techQuality?: string;
      acceptance?: string;
      paymentTerms?: string;
      costRows?: unknown[];
      inquirySheets?: unknown[];
    },
  ) => http.put<any, any>(`/procurement-tasks/${id}/pre-meeting-minutes`, data),
  /** 采购公告（任务 3.3）：仅「单项采购」任务可用；采购清单来自总采购清单（只读） */
  notice: (id: string) => http.get<any, any>(`/procurement-tasks/${id}/notice`),
  saveNotice: (
    id: string,
    data: {
      procurementNo?: string;
      procurementTime?: string | null;
      content?: string;
      techQuality?: string;
      acceptanceMethod?: string;
      paymentMethod?: string;
      contacts?: string[];
      contactPhones?: string[];
    },
  ) => http.put<any, any>(`/procurement-tasks/${id}/notice`, data),
  /** 采购文件（任务 3.4）：仅「单项采购」任务可用；入口条件为采购公告已完成，采购清单来自总采购清单 */
  document: (id: string) => http.get<any, any>(`/procurement-tasks/${id}/document`),
  /** 关联合同模板（补充四：采购文件「导出合同模板 / 预览合同模板」数据来源） */
  contractTemplate: (id: string) => http.get<any, any>(`/procurement-tasks/${id}/contract-template`),
  saveDocument: (
    id: string,
    data: {
      procurementTime?: string | null;
      responseDeposit?: number | null;
      quoteDescription?: string;
    },
  ) => http.put<any, any>(`/procurement-tasks/${id}/document`, data),
  /** 成交报告（任务 3.5）：仅「单项采购」任务可用；入口条件为采购文件已完成 */
  resultReport: (id: string) => http.get<any, any>(`/procurement-tasks/${id}/result-report`),
  saveResultReport: (
    id: string,
    data: {
      unitCount?: number | null;
      openTime?: string | null;
      openPlace?: string;
      reviewMembers?: string;
      approvedCount?: number | null;
      participantCount?: number | null;
      abstainCount?: number | null;
      validFileCount?: number | null;
      /** 拟推荐成交候选人（第二轮报价表勾选生成） */
      candidates?: unknown[];
    },
  ) => http.put<any, any>(`/procurement-tasks/${id}/result-report`, data),
  /** 导入「响应单位情况汇总表」（Excel）：导入后自动重建四张表 */
  importResultReport: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post<any, any>(`/procurement-tasks/${id}/result-report/import`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  /** 「响应单位情况汇总表」导入模板下载地址 */
  resultReportTemplateUrl: (id: string) =>
    `${http.defaults.baseURL}/procurement-tasks/${id}/result-report/template`,
  /** 采购价格对比表（任务 3.6）：仅「单项采购」任务可用；入口条件为成交报告已完成 */
  priceCompare: (id: string) => http.get<any, any>(`/procurement-tasks/${id}/price-compare`),
  savePriceCompare: (
    id: string,
    data: {
      /** 计价方式：FIXED 固定价 | FLOATING 浮动价 */
      pricingMethod?: string;
      /** 采购效益分析说明（富文本 HTML） */
      benefitAnalysis?: string;
      /** 明细行：仅提交「成交价不含税单价 / 备注」，其余列由后端按总采购清单回填 */
      items?: unknown[];
    },
  ) => http.put<any, any>(`/procurement-tasks/${id}/price-compare`, data),
  remove: (id: string) => http.delete<any, any>(`/procurement-tasks/${id}`),
  /** 问题二：删除子模块记录并回退流程（仅流程最末端模块可删，删除后上一阶段恢复可编辑） */
  deleteModule: (id: string, moduleKey: string) =>
    http.delete<any, any>(`/procurement-tasks/${id}/modules/${moduleKey}`),
};

export const dailyApi = {
  list: (params?: any) => http.get<any, any>('/daily-reports', { params }),
  detail: (id: string) => http.get<any, any>(`/daily-reports/${id}`),
  create: (data: any) => http.post<any, any>('/daily-reports', data),
  update: (id: string, data: any) => http.put<any, any>(`/daily-reports/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/daily-reports/${id}`),
  materialTypes: (category: string) => http.get<any, any>('/daily-reports/material-types', { params: { category } }),
  // 按合同聚合日报「结算数量」合计（补充协议：原合同剩余数量 = 原合同数量 − 日报已发生数量）
  contractSettledQty: (contractId: string) =>
    http.get<any, any>('/daily-reports/contract-settled-qty', { params: { contractId } }),
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

/**
 * 收领单（日报管理 → 收领单，与总日报平级）
 * - contractMaterials：选择物资合同后带出该合同的合同物资清单
 * - push：把明细推送到总日报
 */
export const receiptOrderApi = {
  list: (params?: any) => http.get<any, any>('/receipt-orders', { params }),
  detail: (id: string) => http.get<any, any>(`/receipt-orders/${id}`),
  nextNo: () => http.get<any, any>('/receipt-orders/next-no'),
  contractMaterials: (contractId: string) =>
    http.get<any, any>('/receipt-orders/contract-materials', { params: { contractId } }),
  // 需求 2.4.1 供应单位 4 类 Tab 数据源（供应商/其他项目/分包商/本项目）
  partyOptions: (keyword?: string) =>
    http.get<any, any>('/receipt-orders/party-options', { params: { keyword } }),
  // 需求 2.4.2 领用单位 3 类 Tab 数据源（分包商/本项目/其他项目）
  receivingUnitOptions: (keyword?: string) =>
    http.get<any, any>('/receipt-orders/receiving-unit-options', { params: { keyword } }),
  // 需求 2.5 互锁：按分包商带出其关联分包合同
  subcontractorContracts: (subcontractorId: string) =>
    http.get<any, any>('/receipt-orders/subcontractor-contracts', { params: { subcontractorId } }),
  create: (data: any) => http.post<any, any>('/receipt-orders', data),
  update: (id: string, data: any) => http.put<any, any>(`/receipt-orders/${id}`, data),
  push: (id: string) => http.post<any, any>(`/receipt-orders/${id}/push`),
  remove: (id: string) => http.delete<any, any>(`/receipt-orders/${id}`),
};

/**
 * 分包商库（基础信息管理 → 分包商库）
 * 数据来源：分包材料员授权委托书；导出 PDF 后落库为「编辑中」，
 * 上传签字盖章版 + 签字截图后流转为「已完成」。
 */
export const subcontractorApi = {
  list: (params?: any) => http.get<any, any>('/subcontractors', { params }),
  options: (keyword?: string) => http.get<any, any>('/subcontractors/options', { params: { keyword } }),
  detail: (id: string) => http.get<any, any>(`/subcontractors/${id}`),
  create: (data: any) => http.post<any, any>('/subcontractors', data),
  update: (id: string, data: any) => http.put<any, any>(`/subcontractors/${id}`, data),
  remove: (id: string) => http.delete<any, any>(`/subcontractors/${id}`),
  /** 导出 PDF 后落库（编辑中），同分包商 + 同授权人去重 */
  exportMark: (data: any) => http.post<any, any>('/subcontractors/export-mark', data),
  /** 上传签字盖章版委托书 + 签字截图 → 已完成 */
  complete: (id: string, data: any) => http.post<any, any>(`/subcontractors/${id}/complete`, data),
  /** 授权委托书正文 HTML（打印就绪），用于预览与导出 PDF */
  letterHtml: (id: string) =>
    http.get<any, string>(`/subcontractors/${id}/letter`, {
      responseType: 'text',
      headers: { 'x-raw-response': '1' },
      transformResponse: [(d: any) => d],
    } as any),
  /** 按表单值实时渲染委托书 HTML（未落库前预览） */
  previewHtml: (data: any) =>
    http.post<any, string>('/subcontractors/preview', data, {
      responseType: 'text',
      headers: { 'x-raw-response': '1' },
      transformResponse: [(d: any) => d],
    } as any),
};
