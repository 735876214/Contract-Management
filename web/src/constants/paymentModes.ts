/**
 * **付款安排**的前端镜像（与后端 `server/src/common/utils/pay-ratio.ts` 的 `PAYMENT_MODES` 一一对应）。
 *
 * ⚠️ 这是**跨包镜像常量**，与采购工作流链（`procurementWorkflow.ts` ↔ `procurementChain.ts`）同一套路：
 * 必须**手工同步改**，由 `server/test/payRatio.spec.mts` 锁死两侧一致（label 也要求相等，
 * 因为下拉里显示的就是它 —— 文案不一致会让同一种安排在页面与文档里长得不一样）。
 *
 * 分期明细（`tranches`）不在前端镜像里：应付节点由服务端引擎算（`overdue-calculator`），
 * 前端只负责"给人看"的说明文字。
 */
export interface PaymentModeOption {
  value: string;
  label: string;
}

export const PAYMENT_MODE_OPTIONS: PaymentModeOption[] = [
  { value: 'M65_1', label: '月度结算：次月 30 日前支付 65%' },
  { value: 'M65_3', label: '月度结算：次月 20% + 次次月 20% + 次次次月 25%（合计 65%）' },
  { value: '100', label: '次月 25 日前支付 100%' },
  { value: '3382', label: '第 3 个月内支付 80%，第 6 个月支付剩余（合计 100%）' },
  { value: 'CUSTOM', label: '自定义（需另填「月度结算办理比例」）' },
];

/** 自定义付款安排：比例由人工填写 */
export const CUSTOM_PAYMENT_MODE = 'CUSTOM';
