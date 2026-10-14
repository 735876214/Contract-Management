/**
 * 核心业务状态 **code 的单一事实源**（评审意见「核心业务枚举不用裸字符串」）。
 *
 * == 与「字典驱动」的关系（不冲突，是分工）==
 * - **标签 / 颜色 / 排序 / 是否可选** 仍由 `dict_type` / `dict_item` 提供（业务可自助维护）；
 * - **code 本身** 收敛到本文件：service 里写 `SETTLEMENT_STATUS.DRAFT` 而不是 `'DRAFT'`，
 *   这样"同一语义在多处各写一遍"的漂移（历史上 `contract.service.ts` 自造了一套 `STATUS_*`）
 *   与拼写错误都被类型系统挡住；
 * - 业务表**仍存 code 字符串**（不加数据库枚举，铁律 4 不变）。
 *
 * == 防漂移 ==
 * `server/test/statusCodes.spec.mts` 双向锁定：
 * ① 有字典背书的组（settlement/payment/invoice/invoice_review/site_confirm/contract_execution/
 *   bidder_status/evaluation_conclusion）必须与字典项**集合完全相等**；
 * ② 五态合同类型必须与 `schema.prisma` 的 `enum ContractType` 完全相等；
 * ③ 采购任务状态必须与 `TASK_STATUS_LABELS` 的键集合完全相等；④ 组内 code 不得重复。
 * 任何一边新增/改名而另一边没跟上，测试即红。
 *
 * ⚠️ 与字典同名但语义不同的坑：字典 `contract_status`（"合同起草状态"）只有 DRAFT/COMPLETED，
 * 而 `Contract.status` 是 DRAFT/APPROVING/SIGNED（非字典驱动）——两者不是一回事，别混用。
 */

/** 字典 typeCode（供 `dict.validate()` 使用，避免手写字符串拼错） */
export const DICT_TYPES = {
  CONTRACT_TYPE: 'contract_type',
  CONTRACT_STATUS: 'contract_status',
  SETTLEMENT_STATUS: 'settlement_status',
  PAYMENT_STATUS: 'payment_status',
  INVOICE_STATUS: 'invoice_status',
  INVOICE_REVIEW_STATUS: 'invoice_review_status',
  INVOICE_TRANSFER_STATUS: 'finance_transfer_status',
  CONTRACT_EXECUTION_STATUS: 'contract_execution_status',
  SITE_CONFIRM_STATUS: 'site_confirm_status',
  BIDDER_STATUS: 'bidder_status',
  EVALUATION_CONCLUSION: 'evaluation_conclusion',
} as const;

/**
 * 合同状态：`Contract.status`（**非字典驱动**）。
 * 草稿 → 提交 → 审批中 → 签章；驳回把「审批中/已签章」打回草稿（见 `constants/workflowGuards.ts`）。
 */
export const CONTRACT_STATUS = {
  DRAFT: 'DRAFT',
  APPROVING: 'APPROVING',
  SIGNED: 'SIGNED',
} as const;
export type ContractStatus = (typeof CONTRACT_STATUS)[keyof typeof CONTRACT_STATUS];

/**
 * 历史遗留：早期合同行把 `Contract.status` 写成过字典 `contract_status` 的 `COMPLETED`
 * （该语义现由 `Contract.execStatus` 表达）。列表查询需**兼容展示**这类旧行，故保留具名常量，
 * 避免它被当成"随手写的魔法字符串"删掉。
 */
export const LEGACY_CONTRACT_STATUS_COMPLETED = 'COMPLETED';

/** 结算单状态（dict `settlement_status`） */
export const SETTLEMENT_STATUS = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  INVOICED: 'INVOICED',
  PAID: 'PAID',
  DONE: 'DONE',
} as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUS)[keyof typeof SETTLEMENT_STATUS];

/** 付款记录状态（dict `payment_status`）：失败/已退款**不计入**累计付款 */
export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PARTIAL: 'PARTIAL',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

/** 发票状态（dict `invoice_status`）：查验仅用于登记核对，不代表验真 */
export const INVOICE_STATUS = {
  WAIT_VERIFY: 'WAIT_VERIFY',
  VERIFIED: 'VERIFIED',
  CERTIFIED: 'CERTIFIED',
  DEDUCTED: 'DEDUCTED',
  ABNORMAL: 'ABNORMAL',
  CANCELLED: 'CANCELLED',
  RED: 'RED',
} as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

/** 发票信息审核状态（dict `invoice_review_status`） */
export const INVOICE_REVIEW_STATUS = {
  PENDING: 'PENDING',
  PASSED: 'PASSED',
  REJECTED: 'REJECTED',
} as const;
export type InvoiceReviewStatus = (typeof INVOICE_REVIEW_STATUS)[keyof typeof INVOICE_REVIEW_STATUS];

/** 合同执行情况（dict `contract_execution_status`，台账合规判定用） */
export const CONTRACT_EXECUTION_STATUS = {
  DRAFT: 'DRAFT',
  UNUSED: 'UNUSED',
  EXECUTING: 'EXECUTING',
  DONE_UNSETTLED: 'DONE_UNSETTLED',
  DONE_SETTLED: 'DONE_SETTLED',
} as const;
export type ContractExecutionStatus = (typeof CONTRACT_EXECUTION_STATUS)[keyof typeof CONTRACT_EXECUTION_STATUS];

/** 现场确认状态（dict `site_confirm_status`）：只有「已确认」计入结算口径（口径开关见 workflowGuards） */
export const SITE_CONFIRM_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
} as const;
export type SiteConfirmStatus = (typeof SITE_CONFIRM_STATUS)[keyof typeof SITE_CONFIRM_STATUS];

/** 分包商库状态（**非字典驱动**：由委托书导出/推送流程驱动） */
export const SUBCONTRACTOR_STATUS = {
  EDITING: 'EDITING',
  COMPLETED: 'COMPLETED',
} as const;
export type SubcontractorStatus = (typeof SUBCONTRACTOR_STATUS)[keyof typeof SUBCONTRACTOR_STATUS];

/**
 * 投标 / 响应单位状态（dict `bidder_status`，招标域）。
 * 其中 `WON` **由服务端驱动**：在成交报告里勾选「拟推荐成交候选人」即中标，取消勾选回落到
 * 入围/已递交（判据是纯函数 `bidderStatusWhenNotWon()`，见 `constants/procurementFlow.ts`）；
 * 其余状态（弃权/未中标等）由用户在结构化投标单位面板里维护。
 */
export const BIDDER_STATUS = {
  SIGNED_UP: 'SIGNED_UP',
  SUBMITTED: 'SUBMITTED',
  ABSTAINED: 'ABSTAINED',
  SHORTLISTED: 'SHORTLISTED',
  WON: 'WON',
  LOST: 'LOST',
} as const;
export type BidderStatus = (typeof BIDDER_STATUS)[keyof typeof BIDDER_STATUS];

/** 评标结论（dict `evaluation_conclusion`，招标域评标记录） */
export const EVALUATION_CONCLUSION = {
  RECOMMEND: 'RECOMMEND',
  NOT_RECOMMEND: 'NOT_RECOMMEND',
} as const;
export type EvaluationConclusion = (typeof EVALUATION_CONCLUSION)[keyof typeof EVALUATION_CONCLUSION];

/**
 * 采购模块记录状态（**非字典驱动**）：`Procurement*Module.status`。
 * 前端列表另有虚拟值 `UNFILLED`（"无记录"）与 `PUBLISHED`（"已发布"，由 `publishedAt` 推导），
 * 它们**不落库**，故不在此列。
 */
export const MODULE_RECORD_STATUS = {
  EDITING: 'EDITING',
  COMPLETED: 'COMPLETED',
} as const;
export type ModuleRecordStatus = (typeof MODULE_RECORD_STATUS)[keyof typeof MODULE_RECORD_STATUS];
