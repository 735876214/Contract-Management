/**
 * 合同归档完整性校验（业务口径 2026-10-18：单向归档）。
 *
 * 归档是业务终态：**不提供解除归档**。归档前必须确认下游单据已经收口；
 * 归档后只锁业务单据的写操作，**不锁发票/付款/读取/导出**（允许事后补录，这里只给 warning）。
 *
 * 纯函数（零依赖），供 `contract.service.archiveCheck()` 调用，
 * 由 `server/test/contractArchive.spec.mts` 直接加载锁定。
 */

export interface ArchiveCheckInput {
  /** 合同是否已签章（`status = SIGNED`） */
  signed: boolean;
  /** 合同执行情况（dict `contract_execution_status`） */
  execStatus: string | null;
  /** 是否存在任一在下游（日报/收领单/结算/总结算/发票/付款） */
  hasAnyDownstream: boolean;
  /** 草稿状态的结算单编号（非空即阻断） */
  draftSettlementCodes: string[];
  /** 未完成的总结算单编号（非空即阻断） */
  pendingFinalSettlementCodes: string[];
  /** 未挂结算单的收领单数量 */
  unsettledReceiptCount: number;
  /** 未纳入结算的已确认总日报行数量 */
  dailyRowsWithoutSettlement: number;
  /** 待查验发票数量（仅 warning） */
  pendingInvoiceCount: number;
  /** 未付金额（已结 − 已付；>0 仅 warning） */
  unpaidAmount: number;
}

export interface ArchiveCheckResult {
  canArchive: boolean;
  blockers: string[];
  warnings: string[];
}

const DONE_SETTLED = 'DONE_SETTLED';

/** 返回阻断项与提示项；`blockers` 为空才允许归档 */
export function collectArchiveBlockers(input: ArchiveCheckInput): ArchiveCheckResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.signed) blockers.push('合同尚未签章');

  if (input.draftSettlementCodes.length) {
    blockers.push(`存在草稿结算单：${input.draftSettlementCodes.slice(0, 5).join('、')}`);
  }
  if (input.pendingFinalSettlementCodes.length) {
    blockers.push(`存在未完成的总结算单：${input.pendingFinalSettlementCodes.slice(0, 5).join('、')}`);
  }
  if (input.unsettledReceiptCount > 0) {
    blockers.push(`存在 ${input.unsettledReceiptCount} 张未挂结算单的收领单`);
  }
  if (input.dailyRowsWithoutSettlement > 0) {
    blockers.push(`存在 ${input.dailyRowsWithoutSettlement} 条未纳入结算的总日报行`);
  }
  // 没有任何下游的已签章合同（如未使用的框架协议）允许归档；
  // 有下游就必须先走完「已完已结」，避免归档锁死未收尾的链路。
  if (input.hasAnyDownstream && input.execStatus !== DONE_SETTLED) {
    blockers.push('合同尚未「已完已结」（存在下游单据，需先完成总结算）');
  }

  if (input.pendingInvoiceCount > 0) {
    warnings.push(`有 ${input.pendingInvoiceCount} 张发票待查验（归档后仍可补录/查验）`);
  }
  if (input.unpaidAmount > 0) {
    warnings.push(`尚有未付款金额 ${input.unpaidAmount.toFixed(2)} 元（归档后仍可补录付款）`);
  }

  return { canArchive: blockers.length === 0, blockers, warnings };
}
