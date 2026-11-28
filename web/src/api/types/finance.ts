import type { Dateish, Decimalish, Id } from './common.ts';

/**
 * 财务域（合同资金参数 / 保理费用台账 / 逾期利息台账）的响应/请求类型。
 *
 * ## 真理源（改这里之前先改那边，否则 int spec 会红）
 * - `server/src/modules/finance/finance.service.ts` 各方法返回；
 * - 逾期派生引擎 `server/src/modules/finance/overdue-calculator.ts`（`PayableDerived` / `OverduePayableInput`）；
 * - 逾期汇总 `server/src/modules/finance/overdue-summary.ts`（`OverdueStats`）。
 *
 * ## ⚠️ 两条不同的金额管线（不要混）
 * - **过 `num()` → number**：`contractParams` 的费率/天数、`overdue` 列表行与其派生值、全部 `stats`、
 *   `previewOverdue` 的行与 stats、`allocations`、`factoring.totals`。
 * - **Prisma Decimal 原样 → string**：`FactoringCost` 行的全部金额、`OverduePayment.paymentAmount`、
 *   `generateOverdue` 返回的 `OverduePayable` 行的全部金额/比例（raw create 结果，未过 num）。
 * 同一个 `OverduePayable` 概念：`overdue` 列表里是 number，`generateOverdue` 里是 string。
 */

/** 合同资金参数（`GET /finance/contract-params/:id`）；费率/天数已过 num() → number。 */
export interface FinanceContractParams {
  contractId: Id;
  contractCode: string;
  contractName: string;
  supplierName: string;
  projectName: string;
  /** 付款模式（默认 '100'） */
  paymentMode: string;
  monthlyRate: number;
  graceDays: number;
  interestCapRatio: number;
  /** 系统参数原文（100% 付款模式说明） */
  mode100Description: string;
  /** 系统参数原文（33.82% 付款模式说明） */
  mode3382Description: string;
  overrides: {
    monthlyRate: number | null;
    graceDays: number | null;
    interestCapRatio: number | null;
    paymentMode: string | null;
  };
}

/** 保理费用台账一行（raw Prisma `FactoringCost` —— 金额是 **Decimal → string**）。 */
export interface FinanceFactoringRow {
  id: Id;
  contractId: Id;
  seqNo: number;
  financingDate: Dateish;
  /** Decimal → string */
  financingAmount: string | null;
  /** Decimal → string */
  actualReceipt: string | null;
  /** Decimal → string */
  financingInterest: string | null;
  /** Decimal → string */
  handlingFee: string | null;
  /** Decimal → string */
  totalCost: string | null;
  settlementMonth: string | null;
  remark: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
  /** 展示补充（后端并上来的合同/供应商名） */
  supplierName: string;
  contractCode: string;
  contractName: string;
}

/** 保理费用台账行**可能出现**的全部键（序列化后的 literal 键）。 */
export const FINANCE_FACTORING_ROW_KEYS = [
  'id',
  'contractId',
  'seqNo',
  'financingDate',
  'financingAmount',
  'actualReceipt',
  'financingInterest',
  'handlingFee',
  'totalCost',
  'settlementMonth',
  'remark',
  'createdAt',
  'version',
  'updatedAt',
  'supplierName',
  'contractCode',
  'contractName',
] as const;

/** 保理台账合计（`totals`，已过 num+round → number）。 */
export interface FinanceFactoringTotals {
  financingAmount: number;
  actualReceipt: number;
  financingInterest: number;
  handlingFee: number;
  totalCost: number;
}

/** 合同摘要（保理/逾期列表的 `contract` 字段；跨合同查询时为 null）。 */
export interface FinanceContractHead {
  id: Id;
  code: string;
  name: string;
  supplierName: string;
}

/** `GET /finance/factoring-costs` 列表响应。 */
export interface FinanceFactoringResponse {
  /** 指定 contractId 时的合同头；不指定（全项目）为 null */
  contract: FinanceContractHead | null;
  list: FinanceFactoringRow[];
  total: number;
  totals: FinanceFactoringTotals;
}

/** 逾期利息台账一行（`overdue` 列表 —— 已过 num → number；含派生列）。 */
export interface FinanceOverdueRow {
  id?: Id;
  settlementMonth: string;
  periodSeq?: number;
  materialAmount: number | null;
  paymentRatio: number | null;
  payableDate: Dateish;
  waived: boolean;
  prevCumulative: number | null;
  remark: string | null;
  isSettlementPeriod: boolean;
  /** 派生（PayableDerived） */
  payableAmount: number;
  overdueStartDate: string;
  interestAmount: number;
  overdueDays: number;
  overdueInterest: number;
  paidAmount: number;
  remaining: number;
  /** 抵扣分片（内部投影也随派生展开到列表行） */
  chunks: Array<{
    paymentId: string | null;
    paymentDate: string;
    amount: number;
    overdueDays: number;
    interest: number;
  }>;
  /** 展示补充 */
  supplierName: string;
  contractCode: string;
  contractName: string;
}

/** 逾期汇总统计（`OverdueStats`）。 */
export interface FinanceOverdueStats {
  totalMaterial: number;
  totalPayment: number;
  currentCumulative: number;
  cumulativeByMonth: Record<string, number>;
  currentMonth: string;
  prevCumulative: number;
  currentSettlement: number;
  totalInterest: number;
  capRatio: number;
  capAmount: number;
  capUsage: number;
  interestRatio: number;
}

/** `GET /finance/overdue-interests` 列表响应。 */
export interface FinanceOverdueResponse {
  /** 指定合同时的合同参数头；跨合同（全项目）为 null */
  contract: FinanceContractParams | null;
  list: FinanceOverdueRow[];
  total: number;
  stats: FinanceOverdueStats;
}

/** 付款模式定义（`GET /finance/payment-modes`）。 */
export interface FinancePaymentMode {
  mode: string;
  label: string;
  tranches: Array<{ ratio: number; plusMonths: number; day: number }>;
}

/** 逾期付款流水一行（raw Prisma `OverduePayment` + allocations —— `paymentAmount` 是 **Decimal → string**）。 */
export interface FinanceOverduePayment {
  id: Id;
  contractId: Id;
  paymentDate: string;
  /** Decimal → string */
  paymentAmount: string;
  remark: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
  allocations: Array<{
    payableId: string | null;
    settlementMonth: string | null;
    periodSeq: number | null;
    amount: number;
    overdueDays: number;
    interest: number;
  }>;
}

/** `GET /finance/overdue-payments` 响应。 */
export interface FinanceOverduePaymentsResponse {
  contract: FinanceContractParams;
  list: FinanceOverduePayment[];
}

/** 预览派生行（`POST /finance/overdue-interests/preview`；值过 num → number，可为 null）。 */
export interface FinanceOverduePreviewRow {
  periodSeq: number;
  materialAmount: number | null;
  paymentRatio: number | null;
  payableAmount: number | null;
  overdueStartDate: string | null;
  interestAmount: number | null;
  overdueDays: number | null;
  overdueInterest: number | null;
  paidAmount: number;
  remaining: number;
}

/** `POST /finance/overdue-interests/preview` 响应。 */
export interface FinanceOverduePreviewResponse {
  contract: FinanceContractParams;
  rows: FinanceOverduePreviewRow[];
  stats: FinanceOverdueStats;
}

/** `generateOverdue` 返回的 raw `OverduePayable` 行（金额 **Decimal → string**）。 */
export interface FinanceOverduePayableCreated {
  id: Id;
  contractId: Id;
  settlementMonth: string;
  periodSeq: number;
  materialAmount: string | null;
  paymentRatio: string | null;
  payableAmount: string | null;
  payableDate: Dateish;
  overdueStartDate: Dateish;
  interestAmount: string | null;
  overdueDays: number | null;
  monthlyRate: string | null;
  overdueInterest: string | null;
  waived: boolean;
  prevCumulative: string | null;
  remark: string | null;
  isSettlementPeriod: boolean;
  createdAt: string;
  version: number;
  updatedAt: string;
}

/** 保理/逾期列表的查询参数（`contractId` 由 API 方法拼进 query）。 */
export interface FinanceLedgerListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  settlementMonth?: string;
}

/** 金额列在返回里的可能形态（Decimalish 提示用；具体见各接口注释）。 */
export type FinanceMoney = Decimalish;
