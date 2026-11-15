/**
 * 跨域只读查询层（Read Model）。
 *
 * 约定：**只有这里**可以直接对多个业务域的表做只读查询；业务模块（尤其 `archive` / `ai`
 * 这类聚合器）应通过本层取数，而不是在 service 里散写 `prisma.<任意模型>`。
 * 边界由 `scripts/check-module-boundaries.mjs` 锁定。
 *
 * 入口显式列出符号（不用 `export *`）：查得到"这一层对外承诺了什么"。
 */
export {
  archiveContracts,
  archiveContractsWithFinance,
  archiveFinalSettlements,
  archiveInvoiceImages,
  archiveLaborAuthLedgers,
  archiveLaborReceivingDocs,
  archiveMonthlyProfitLoss,
  archiveMonthlySettlementDates,
  archiveProject,
  archiveReceiptScans,
} from './archive-queries';

export {
  countDailyReports,
  loadContractChainFacts,
  loadContractExecStatuses,
  loadContractForFields,
  loadDailyReportCounts,
  loadDomainScalars,
  loadInvoiceFacts,
  loadMilestoneFacts,
  loadPaymentFacts,
  loadProcurementTaskCounts,
  loadProjectFacts,
  loadProjectHeader,
  loadProjectScope,
  loadSettlementFacts,
  loadSupplierById,
  loadSupplierNames,
} from './ai-fact-queries';

export type { FactDateRange, PayMonthRange, ProjectScopeOptions } from './ai-fact-queries';
