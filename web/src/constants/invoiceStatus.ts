/**
 * 发票状态常量（`invoice_status` 字典的**前端镜像**）。
 *
 * 与后端 `server/src/constants/statuses.ts` 的 `INVOICE_STATUS` / `INVOICE_EXCLUDED_STATUSES`
 * 逐条相等，由 `server/test/invoiceStatus.spec.mts` 锁死——改一侧必须同步另一侧。
 *
 * 作废（`CANCELLED`）与红冲（`RED`）是**终态**：不计入台账/履约占/工作台等金额口径，
 * 只能经列表行上的专用操作进入，不能通过编辑表单改入或改出。
 */
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

/** 终态：作废 / 红冲（后端 `INVOICE_EXCLUDED_STATUSES` 的镜像） */
export const INVOICE_TERMINAL_STATUSES: string[] = [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.RED];

export function isInvoiceTerminalStatus(statusCode?: string | null): boolean {
  return INVOICE_TERMINAL_STATUSES.includes(String(statusCode ?? ''));
}
