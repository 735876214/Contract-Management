/**
 * 工作台 / 看板域（`dashboardApi`）。真理源：`server/src/modules/dashboard/dashboard.service.ts`。
 *
 * 各接口返回**专门的对象/数组**（不是分页信封）；金额已由服务端 `round4(num(...))` → **number**。
 * 唯一例外：`reminders.pendingInvoices[].amountWithTax` 是 raw 发票字段 → **Decimal 字符串**。
 */

/** `GET /dashboard/overview`（金额过 round4 → number）。 */
export interface DashboardOverview {
  contractCount: number;
  contractChainCount: number;
  supplementCount: number;
  contractAmount: number;
  settleAmount: number;
  paidAmount: number;
  invoiceAmount: number;
  settlementCount: number;
  executingCount: number;
}

/** `GET /dashboard/trend` 一项（12 个月）。 */
export interface DashboardTrendPoint {
  month: string;
  settleAmount: number;
  paidAmount: number;
}

/** `GET /dashboard/contract-type` 一项。 */
export interface DashboardContractTypePoint {
  typeCode: string;
  count: number;
  chainCount: number;
  amount: number;
}

/** `GET /dashboard/invoice-stats`。 */
export interface DashboardInvoiceStats {
  byType: Array<{ typeCode: string; count: number; amount: number }>;
  byStatus: Array<{ statusCode: string; count: number }>;
}

/** `GET /dashboard/reminders`。 */
export interface DashboardReminders {
  pendingInvoices: Array<{
    id: string;
    invoiceNo: string;
    issuer: string;
    /** raw 发票字段 → Decimal 字符串 */
    amountWithTax: string;
  }>;
  amountAlerts: Array<{
    contractId: string;
    code: string;
    name: string;
    level: string;
    reasons: string[];
    settledRatioPct: number | null;
    supplementRatioPct: number | null;
    currentAmount: number | null;
    settledTotal: number;
  }>;
  amountAlertTotal: number;
  paymentRatioAlerts: Array<{
    contractId: string;
    code: string;
    name: string;
    payRatio: number;
    settledTotal: number;
    paidTotal: number;
    limit: number;
    paidRatioPct: number | null;
    reason: string;
  }>;
  paymentRatioAlertTotal: number;
}

/** 工作台待办的一个条目。 */
export interface DashboardTodoItem {
  key: string;
  title: string;
  code?: string;
  level: 'RED' | 'AMBER' | 'INFO';
  hint?: string;
  target: { path: string; editor?: string; query?: Record<string, string> };
}

/** 工作台待办的一个分类组。 */
export interface DashboardTodoGroup {
  key: string;
  label: string;
  count: number;
  items: DashboardTodoItem[];
}

/** `GET /dashboard/todos`。 */
export interface DashboardTodos {
  generatedAt: string;
  total: number;
  groups: DashboardTodoGroup[];
}
