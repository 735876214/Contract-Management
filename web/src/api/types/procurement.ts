import type { Dateish, ListParams, Paged } from './common.ts';

/**
 * 采购任务域（批次二 · 任务 2.1～3.6 + 招标域）的响应/请求类型。
 *
 * ## 真理源（改这里之前先改那边，否则 int spec 会红）
 *
 * - 任务行：`server/src/modules/procurement/procurement-task-shared.ts#serializeTask`
 *   （不是直接回 Prisma 行——它把 `purpose/techQuality/acceptanceMethod/paymentMethod` 空值兜成 `''`、
 *   `statusLabel` 由 `TASK_STATUS_LABELS` 派生、加了派生字段 `contractId`）；
 * - 总采购清单行：`procurement-task.service.ts#serializeItem`（金额过 `num()` → number）；
 * - 阶段视图：`procurement-task.service.ts#buildStages`（`stageView` 推导 done/editing/locked + 末尾合同阶段）；
 * - 六个阶段表单 / 投标 / 价格对比外壳：`procurement-stage-forms.service.ts` 各 `async xxx(taskId)` 的返回对象；
 * - 列表查询参数：`procurement-task.service.ts#findAll()` 里 `query.*` 实际读取的键（**不是**页面上筛选项的 label）。
 *
 * ## 为什么值得单独锁一份
 *
 * 采购任务是最复杂的工作流域：一个任务有六张阶段子单据 + 投标/评标/价格对比，`findAll` 还按 `module`
 * 参数联表带出**不同形状**的 `module` 字段（每模块 select 不同）。字段漂移会让列表/详情读到 `undefined`
 * 而不报错。故这里把「任务行 + 列表参数 + 总清单行」用 `*_KEYS` 逐字锁住（`api-shape-procurement.int.spec.ts`）。
 */

/** 采购类型：引用框架协议 / 单项采购 / 紧急采购 */
export type ProcurementTaskType = 'FRAMEWORK' | 'SINGLE' | 'EMERGENCY';

/** 任务行（`serializeTask` 的返回；列表与详情共有部分）。金额/数量一律 number（过 `num()`/`toWan()`）。 */
export interface ProcurementTaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  /** 用途（`serializeTask` 把 null 兜成 `''`） */
  purpose: string;
  status: string;
  /** 状态中文（`TASK_STATUS_LABELS` 派生） */
  statusLabel: string;
  /** 当前阶段下标（0 起；合同阶段=链尾之后） */
  stage: number;
  /** 乐观锁：更新时必须原样回传（服务端 `assertVersion` 强制，缺失/过期一律 409） */
  version: number;
  preMeetingRequired: boolean;
  totalListId: string | null;
  /** 关联主合同 id（无关联 → null） */
  contractId: string | null;
  /** 采购品类 */
  procurementCategory: string | null;
  techQuality: string;
  acceptanceMethod: string;
  paymentMethod: string;
  technicalClauseId: string | null;
  qualityClauseId: string | null;
  paymentClauseId: string | null;
  acceptanceClauseId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 任务行**可能出现**的全部键（`serializeTask` 里的 literal 键）。 */
export const PROCUREMENT_TASK_ROW_KEYS = [
  'id',
  'taskNo',
  'type',
  'content',
  'purpose',
  'status',
  'statusLabel',
  'stage',
  'version',
  'preMeetingRequired',
  'totalListId',
  'contractId',
  'procurementCategory',
  'techQuality',
  'acceptanceMethod',
  'paymentMethod',
  'technicalClauseId',
  'qualityClauseId',
  'paymentClauseId',
  'acceptanceClauseId',
  'createdAt',
  'updatedAt',
] as const;

/** 阶段视图一格：done（已发布）/ editing（当前编辑中）/ locked（前置未发布）。 */
export type ProcurementStageState = 'done' | 'editing' | 'locked';

/** 阶段链一格（末尾附「生成合同」阶段，key=`CONTRACT`）。 */
export interface ProcurementStage {
  key: string;
  label: string;
  state: ProcurementStageState;
}

/**
 * `GET /procurement-tasks` 列表行 = 任务行 + 预计采购金额 + 按 `module` 联表带出的模块字段。
 * `module` 的形状**随请求的 `module` 参数变化**（每模块 select 不同），故这里用宽松 object；
 * 需要一个具体形状时用下方 `ProcurementModuleRow`（列表只回 select 里的少数列，不是完整单据）。
 */
export interface ProcurementTaskListRow extends ProcurementTaskRow {
  /** 预计采购金额（**万元**，`toWan` 已换算） */
  estimatedAmountWan: number;
  /** 未传 `module` 时为 null；传了则为其模块的联表摘要（见 `MODULE_LIST_RELATIONS`） */
  module: Record<string, unknown> | null;
}

/**
 * `GET /procurement-tasks` 实际认的查询参数名。
 *
 * ⚠️ 这里的键必须与服务端 `findAll()` 里 `query.*` 读取的键**逐字相同**；
 * 页面的筛选项只允许用这个集合里的 key（`api-shape-procurement.int.spec.ts` 会比对）。
 */
export const PROCUREMENT_TASK_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'keyword',
  'status',
  'type',
  'preMeetingRequired',
  'taskNo',
  'content',
  'module',
  'publishedFrom',
  'publishedTo',
  'moduleStatus',
  'meetingFrom',
  'meetingTo',
  'host',
  'procTimeFrom',
  'procTimeTo',
  'contact',
  'openFrom',
  'openTo',
  'pricingMethod',
] as const;

/** 采购任务列表查询参数（key 见 `PROCUREMENT_TASK_LIST_PARAM_KEYS`）。 */
export interface ProcurementTaskListParams extends ListParams {
  status?: string;
  type?: string;
  /** 采前会列表：传 `'true'` 只回需要采前会的任务 */
  preMeetingRequired?: string;
  taskNo?: string;
  content?: string;
  /** 六模块列表化：模块名（决定联表带出哪张子单据的摘要） */
  module?: string;
  /** 模块状态：PUBLISHED=已完成 / EDITING=编辑中 / UNFILLED=未填写 */
  moduleStatus?: 'PUBLISHED' | 'EDITING' | 'UNFILLED';
  /** 模块发布时间区间（前端传当日 00:00（from）/ 23:59:59（to）） */
  publishedFrom?: string;
  publishedTo?: string;
  /** 采前会专用：会议时间区间 / 主持人 */
  meetingFrom?: string;
  meetingTo?: string;
  host?: string;
  /** 公告 / 采购文件专用：采购时间区间 / 联系人 */
  procTimeFrom?: string;
  procTimeTo?: string;
  contact?: string;
  /** 成交报告专用：开启报价时间区间 */
  openFrom?: string;
  openTo?: string;
  /** 价格对比表专用：计价方式 FIXED / FLOATING */
  pricingMethod?: string;
}

/** 采购任务列表响应（分页）。 */
export type ProcurementTaskListResponse = Paged<ProcurementTaskListRow>;

/** 采购任务详情（`GET /procurement-tasks/:id`）：任务行 + 预计金额 + 阶段视图。 */
export interface ProcurementTaskDetail extends ProcurementTaskRow {
  estimatedAmountWan: number;
  stages: ProcurementStage[];
}

/** 总采购清单行（`serializeItem`）；价格/数量类一律 number（过 `num()`）。 */
export interface ProcurementTotalItem {
  id: string;
  materialBaseId: string;
  materialName: string;
  spec: string;
  unit: string;
  qty: number | null;
  incomePrice: number | null;
  stdCost: number | null;
  marketPrice: number | null;
  infoPrice: number | null;
  planPrice: number | null;
  sortOrder: number;
}

/** 总采购清单行**可能出现的全部键**（`serializeItem` literal 键）。 */
export const PROCUREMENT_TOTAL_ITEM_KEYS = [
  'id',
  'materialBaseId',
  'materialName',
  'spec',
  'unit',
  'qty',
  'incomePrice',
  'stdCost',
  'marketPrice',
  'infoPrice',
  'planPrice',
  'sortOrder',
] as const;

/** `GET /procurement-tasks/:id/total-list`：清单 + 冻结态。 */
export interface ProcurementTotalList {
  /** stage≥1 即已发布 → 冻结（不可再改） */
  frozen: boolean;
  status: string;
  statusLabel: string;
  items: ProcurementTotalItem[];
}

/** 六阶段子单据共用的外壳（各阶段 GET 的公共部分）。`data` 为该模块已保存记录，未填写为 null。 */
export interface ProcurementStageFormEnvelope<TData> {
  task: ProcurementTaskRow;
  /** 本阶段是否已到达（前序阶段已发布） */
  reached?: boolean;
  /** 是否可编辑（编辑中） */
  editable: boolean;
  /** 是否已发布（已完成） */
  published: boolean;
  status: string;
  statusLabel: string;
  /** 已保存的模块记录；未填写 → null */
  data: TData | null;
  [extra: string]: unknown;
}

/** 框架协议事前说明记录（`serializeExplanation`；表格行是 JSON 数组）。 */
export interface ProcurementFrameworkExplanationData {
  id: string;
  taskId: string;
  /** 乐观锁：保存时原样回传（服务端据此校验），缺失则兼容旧行为 */
  version?: number;
  frameworkIntro: string;
  negotiation: string;
  inquiryRows: Record<string, unknown>[];
  priceCompareRows: Record<string, unknown>[];
  execution: string;
  costRows: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  publishedAt: Dateish;
  updatedAt: string;
}

/** 采前会会议纪要记录（`serializeMinutes`）。 */
export interface ProcurementPreMeetingMinutesData {
  id: string;
  taskId: string;
  version?: number;
  meetingTime: Dateish;
  content: string;
  host: string;
  attendees: string;
  writer: string;
  reviewer: string;
  purchaseItems: Record<string, unknown>[];
  techQuality: string;
  acceptance: string;
  paymentTerms: string;
  costRows: Record<string, unknown>[];
  inquirySheets: Record<string, unknown>[];
  publishedAt: Dateish;
  updatedAt: string;
}

/** 采购公告记录（`serializeNotice`）。 */
export interface ProcurementNoticeData {
  id: string;
  taskId: string;
  version?: number;
  procurementNo: string;
  procurementTime: Dateish;
  content: string;
  techQuality: string;
  acceptanceMethod: string;
  paymentMethod: string;
  contacts: string[];
  contactPhones: string[];
  publishedAt: Dateish;
  updatedAt: string;
}

/** 采购文件记录（`serializeDocument`）。 */
export interface ProcurementDocumentData {
  id: string;
  taskId: string;
  version?: number;
  procurementTime: Dateish;
  responseDeposit: number | null;
  quoteDescription: string;
  publishedAt: Dateish;
  updatedAt: string;
}

/** 成交报告记录（`serializeResultReport`；suppliers/candidates 是导入/勾选的 JSON 行）。 */
export interface ProcurementResultReportData {
  id: string;
  taskId: string;
  version?: number;
  unitCount: number | null;
  openTime: Dateish;
  openPlace: string;
  reviewMembers: string;
  approvedCount: number | null;
  participantCount: number | null;
  abstainCount: number | null;
  validFileCount: number | null;
  suppliers: Record<string, unknown>[];
  candidates: Record<string, unknown>[];
  publishedAt: Dateish;
  updatedAt: string;
}

/** 结构化投标单位行（`serializeBidder`）；金额 number | null。 */
export interface ProcurementBidder {
  id: string;
  taskId: string;
  supplierId: string | null;
  bidderName: string;
  seq: number;
  depositPaid: string;
  sealed: string;
  passedFirst: string;
  firstPreTaxTotal: number | null;
  firstTax: number | null;
  secondPreTaxTotal: number | null;
  secondTax: number | null;
  finalPreTaxTotal: number | null;
  status: string;
  bidFileUrl: string;
  remark: string;
  updatedAt: string;
}

/** 评标记录行（`serializeEvaluation`）。 */
export interface ProcurementEvaluation {
  id: string;
  taskId: string;
  bidderId: string;
  evaluator: string;
  score: number | null;
  rank: number | null;
  conclusion: string;
  comment: string;
  evaluatedAt: Dateish;
}

/** `GET /procurement-tasks/:id/bidders`：结构化投标单位 + 评标记录。 */
export interface ProcurementBiddersResponse {
  taskId: string;
  bidders: ProcurementBidder[];
  evaluations: ProcurementEvaluation[];
}

/** 采购价格对比表记录（`serializePriceCompare` 去掉 items，另由外层 `items` 派生）。 */
export interface ProcurementPriceCompareData {
  id: string;
  taskId: string;
  version?: number;
  pricingMethod: string;
  benefitAnalysis: string;
  items: Record<string, unknown>[];
  publishedAt: Dateish;
  updatedAt: string;
}

/** 价格对比表明细行（派生自总清单 + 已保存成交价/备注）。 */
export interface ProcurementPriceCompareItem {
  materialBaseId: string;
  materialName: string;
  spec: string;
  unit: string;
  qty: number | null;
  incomePrice: number | null;
  stdCost: number | null;
  planPrice: number | null;
  infoPrice: number | null;
  dealPrice: number | null;
  remark: string;
}
