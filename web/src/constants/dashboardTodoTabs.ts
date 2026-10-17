/**
 * 「我的待办」分类 Tab 的**前端镜像**（与后端 `server/src/constants/todoCategories.ts` 的
 * key/label 逐条一致，由 `server/test/dashboardTodo.spec.mts` 锁死 —— 与 paymentModes /
 * TASK_STATUS_COLORS 同一套镜像做法：改一侧必须同步另一侧，否则测试红）。
 */

export interface DashboardTodoTab {
  key: string;
  label: string;
}

export const DASHBOARD_TODO_TABS: DashboardTodoTab[] = [
  { key: 'CONTRACT_DRAFT', label: '合同起草' },
  { key: 'CONTRACT_SIGN', label: '合同待签章' },
  { key: 'SETTLEMENT_DRAFT', label: '结算单待提交' },
  { key: 'FINAL_SETTLEMENT', label: '总结算单待办理' },
  { key: 'PAYMENT_PROCEDURE', label: '付款手续待编制' },
  { key: 'INVOICE_VERIFY', label: '待查验发票' },
  { key: 'OVERDUE_INTEREST', label: '逾期利息待对账' },
  { key: 'PROCUREMENT_TODO', label: '采购待编制' },
];
