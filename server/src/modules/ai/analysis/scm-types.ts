/**
 * 课题 7-11 · **供应链运营分析助理（跨项目全景）**——输入行与事实包类型。
 *
 * == 为什么单独一个课题 ==
 * 6-9 / 3-9 / 4-9 都是「单项目 + 命中清单」；7-11 是**跨项目横向对照**：
 * 领导要看的是「A 项目合同签了 1.2 亿、结算只走到 60%、付款却已过 70%」这种
 * 项目之间的落差，而不是某一条单据。所以本层不改判定口径，只改**汇总维度**。
 *
 * == 口径（累计至今，不做区间切片）==
 * - 签约额：`statusCode` 为 `SIGNED`（含历史遗留 `COMPLETED`）的合同，
 *   金额取**链式当前金额**（主合同 + 带符号补充协议，见 `common/utils/contract-chain.ts`），
 *   不用 `amount` 裸值——否则补充协议一签，全景就骗人；
 * - 结算额：非 `DRAFT` 结算单，`actualAmount ?? amount`（与 6-9 同一口径）；
 * - 付款额：排除 `FAILED` / `REFUNDED`（`PAYMENT_EXCLUDED_STATUSES`）；
 * - 开票额：排除 `CANCELLED` / `RED`（作废与红冲不是「开出去的票」）；
 * - 逾期节点：`PENDING` 且 `planDate` 早于基准日（与页面标红、4-9 同口径）。
 *
 * 区间切片故意不做：月度/季度切片已有 `report-facts.ts` 的月报，重复实现两套口径
 * 只会让两个页面对同一个项目给出不同数字。全景就是**累计至今**，`asOf` 写明基准日。
 */

import { type Cents } from '../common/money.ts';

/** 事实包基准日（`YYYY-MM-DD`，由上层注入，规则层不读系统时钟） */
export interface ScmRows {
  projects: ScmProjectRow[];
  contracts: ScmContractRow[];
  settlements: ScmSettlementRow[];
  payments: ScmPaymentRow[];
  invoices: ScmInvoiceRow[];
  milestones: ScmMilestoneRow[];
  suppliers: ScmSupplierRow[];
}

export interface ScmProjectRow {
  id: string;
  code: string;
  name: string;
}

export interface ScmContractRow {
  id: string;
  projectId: string;
  supplierId?: string | null;
  /** 合同用 `status`（dict `contract_status`：DRAFT 草稿 / COMPLETED 已完成），
   *  不是其它表的 `statusCode`——两套字段名在这个库里并存，取数时必须分清 */
  status?: string | null;
  /** 任意可解析金额（Prisma Decimal / string / number） */
  amount?: unknown;
  parentContractId?: string | null;
  /** 补充协议的带符号金额（负数=减账） */
  changeAmount?: unknown;
}

export interface ScmSettlementRow {
  id: string;
  projectId: string;
  statusCode?: string | null;
  amount?: unknown;
  actualAmount?: unknown;
}

export interface ScmPaymentRow {
  id: string;
  projectId: string;
  statusCode?: string | null;
  amount?: unknown;
}

export interface ScmInvoiceRow {
  id: string;
  projectId: string;
  statusCode?: string | null;
  amountWithTax?: unknown;
}

export interface ScmMilestoneRow {
  id: string;
  projectId: string;
  /** 挂在哪份合同上：用于判定该节点是否在「已签合同链」上（草稿合同的计划日不算承诺） */
  contractId?: string | null;
  statusCode?: string | null;
  planDate?: Date | string | null;
}

export interface ScmSupplierRow {
  id: string;
  name: string;
}

/** 单项目汇总（金额均为**元**，两位小数，便于直接进 Markdown 与对账） */
export interface ScmProjectFacts {
  projectId: string;
  code: string;
  name: string;
  contractCount: number;
  signedYuan: number;
  settledYuan: number;
  paidYuan: number;
  invoicedYuan: number;
  /** 已结算未付款（负值 = 付款超过结算，本身就是风险） */
  unpaidYuan: number;
  /** 已结算未开票 */
  uninvoicedYuan: number;
  /** 付款 / 结算（%）；结算为 0 时 null——「无法计算」不是 0% */
  payRatioPct: number | null;
  /** 结算 / 签约（%） */
  settleRatioPct: number | null;
  /** 开票 / 结算（%） */
  invoiceRatioPct: number | null;
  milestoneCount: number;
  overdueMilestones: number;
}

export interface ScmSupplierFacts {
  supplierId: string | null;
  name: string;
  contractCount: number;
  signedYuan: number;
  /** 占全部签约额的百分比 */
  sharePct: number;
}

export interface ScmTotals {
  projectCount: number;
  contractCount: number;
  signedYuan: number;
  settledYuan: number;
  paidYuan: number;
  invoicedYuan: number;
  unpaidYuan: number;
  uninvoicedYuan: number;
  payRatioPct: number | null;
  settleRatioPct: number | null;
  invoiceRatioPct: number | null;
  overdueMilestones: number;
}

/** 事实包：模型只许引用这里的数字，一个新数都不许算 */
export interface ScmFacts {
  /** 基准日 */
  asOf: string;
  totals: ScmTotals;
  /** 按签约额倒序 */
  projects: ScmProjectFacts[];
  /** 供应商集中度（按签约额倒序，默认前 5） */
  suppliers: ScmSupplierFacts[];
  /** 程序算出来的风险提示（模型只许转述，不许自创） */
  risks: string[];
  /** 数据为空（无项目 / 无合同）——此时报告只能说「没有数据」，不许编 */
  empty: boolean;
}

/** 容差与阈值（走系统参数，见 `scm-config.ts`） */
export interface ScmTolerances {
  /** 供应商集中度警戒线（%），默认 50 */
  topSharePct: number;
  /** 开票缺口警戒线（占结算额 %），默认 20 */
  invoiceGapPct: number;
  /** 供应商榜取前几名，默认 5 */
  topSuppliers: number;
}

export const DEFAULT_SCM_TOLERANCES: ScmTolerances = {
  topSharePct: 50,
  invoiceGapPct: 20,
  topSuppliers: 5,
};

/** 金额（分）→ 保留两位小数的「元」数值。仅用于**输出事实包**，计算全程仍是整数分 */
export function centsToYuanNumber(cents: Cents): number {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const scaled = Number(abs) / 100;
  return neg ? -scaled : scaled;
}
