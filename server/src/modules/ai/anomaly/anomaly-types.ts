/**
 * AI 预警 · 结算/付款异常（矩阵课题 6-9）—— **判定口径、类型与金额原语**。
 *
 * == 为什么单独一层 ==
 * 这一层是**纯函数**：不 import Prisma、不 import 模型、不做 IO。原因是财务类判定最容易
 * 翻车的地方就是「让模型算数」与「两处口径各算一遍」：
 * ① 命中判定必须能被 `server/test/*.spec.mts` 裸跑（`npm test` 门禁、秒级、无 DB）；
 * ② 交给 LLM 的只有 `facts` 里**已经算好的字符串**，模型一个字都不许自己算
 *   （与 `ai/report.service.ts` 的「程序算数、模型说话」同一口径）。
 *
 * == 金额原语（为什么不直接用 number）==
 * `Decimal(18,2)` 的整数部分最大 16 位，乘 100 后超过 `Number.MAX_SAFE_INTEGER`（2^53）。
 * 结算/付款金额一旦进入浮点就会在「恰好等于上限」这类边界上给出相反结论（
 * `amount-guard.ts` 的经验：**恰好等于上限不算超**）。所以：
 * - 金额统一 `bigint` **分**（`moneyToCents`）、数量统一 `bigint` **万分之一单位**（`qtyToUnits`）；
 * - 解析走**字符串**（Prisma `Decimal.toString()`），半进位（≥5 进一），不经浮点；
 * - 对外（finding/facts/接口）一律 **元字符串**，避免 `bigint` 进 JSON 报错。
 *
 * 口径出处：`.claude/rules/backend-conventions.md`（防超结/防超付、台账三态、付款比例派生）。
 */

import type { Cents } from '../common/money.ts';

/**
 * 金额/数量/比例原语已上提到 `ai/common/money.ts`（M4 起跨课题共用）。
 * 这里原样转出，`rules-payment.ts` / `anomaly-score.ts` 等既有 import 不用改。
 */
export * from '../common/money.ts';

/** 预警等级（只有两级：业务只区分「必须马上看」与「复核一下」） */
export const ANOMALY_LEVEL = { HIGH: 'HIGH', MEDIUM: 'MEDIUM' } as const;
export type AnomalyLevel = (typeof ANOMALY_LEVEL)[keyof typeof ANOMALY_LEVEL];

export const ANOMALY_LEVEL_LABELS: Record<AnomalyLevel, string> = {
  HIGH: '高风险',
  MEDIUM: '需复核',
};

/**
 * 规则码（**单一事实源**）：`R1-a/b/c` 是「重复结算」的三种真实形态，
 * 详见 `docs/AI应用落地计划.md` §2.2 —— 原方案的「同合同+同期+金额相近」已被
 * `SettlementLedger.settlementId @unique` 与「同合同同月仅一张结算单」从库里挡掉。
 */
export const ANOMALY_CODES = {
  /** R1-a 跨期指纹重复：同合同两张结算单，金额相近且明细物资几乎重合 */
  R1_DUP_ACROSS_PERIOD: 'R1_DUP_ACROSS_PERIOD',
  /** R1-b 同一物资重复计量：同合同同物资跨单计量合计超合同链清单量 */
  R1_DUP_MATERIAL_QTY: 'R1_DUP_MATERIAL_QTY',
  /** R1-c 总结算快照偏离：总结算单明细金额 ≠ 对应月度结算单金额 */
  R1_FINAL_SNAPSHOT_DRIFT: 'R1_FINAL_SNAPSHOT_DRIFT',
  /** R2 超付：累计付款 > 累计结算 × 生效付款比例 */
  R2_OVERPAY: 'R2_OVERPAY',
  /** R3 无效合同付款：付款记录没有合同，或合同尚未签章 */
  R3_PAY_WITHOUT_CONTRACT: 'R3_PAY_WITHOUT_CONTRACT',
  /** R4 票款不一致：同结算单的发票合计 ≠ 结算金额 */
  R4_INVOICE_MISMATCH: 'R4_INVOICE_MISMATCH',
  /** R5 结算早于验收：结算日期早于关联收领单日期 */
  R5_SETTLE_BEFORE_RECEIPT: 'R5_SETTLE_BEFORE_RECEIPT',
  /** R6 付款手续快照偏离：单据上的「开累」与实时台账不一致（事后补录未回改单据） */
  R6_PROCEDURE_SNAPSHOT_DRIFT: 'R6_PROCEDURE_SNAPSHOT_DRIFT',
} as const;
export type AnomalyCode = (typeof ANOMALY_CODES)[keyof typeof ANOMALY_CODES];

export const ANOMALY_CODE_LABELS: Record<AnomalyCode, string> = {
  R1_DUP_ACROSS_PERIOD: '疑似重复结算（跨期）',
  R1_DUP_MATERIAL_QTY: '同一物资重复计量',
  R1_FINAL_SNAPSHOT_DRIFT: '总结算单与月度结算金额不一致',
  R2_OVERPAY: '付款超过应付比例',
  R3_PAY_WITHOUT_CONTRACT: '付款缺少有效合同',
  R4_INVOICE_MISMATCH: '发票金额与结算金额不一致',
  R5_SETTLE_BEFORE_RECEIPT: '结算早于收领单日期',
  R6_PROCEDURE_SNAPSHOT_DRIFT: '付款手续开累金额与台账不一致',
};

/** 命中对象类型（前端据此跳转到对应页面） */
export type FindingEntity = 'contract' | 'settlement' | 'payment' | 'procedure';

/**
 * 一条命中。
 *
 * ⚠️ `facts` 里的每个值都必须是**已经算好的字符串**：LLM 只允许引用这里出现过的数字。
 * 生成措辞后若出现 `facts` 之外的数字，按 `report.service` 的口径视为对账失败（`unknownNumbers`）。
 */
export interface Finding {
  code: AnomalyCode;
  level: AnomalyLevel;
  entity: FindingEntity;
  entityId: string;
  /** 模板串标题（不走模型，保证面板永不空窗） */
  title: string;
  facts: Record<string, string>;
  /** 差额（元字符串，正数 = 超出/重复的金额）；无金额概念时为 null */
  amountDiff: string | null;
}

// ---------------------------------------------------------------------------
// 输入行：与 Prisma 行的**结构化子集**（service 用 select 只取这些列）
// ---------------------------------------------------------------------------

export interface ContractRow {
  id: string;
  code?: string | null;
  name?: string | null;
  amount?: unknown;
  /** `Contract.status`：DRAFT / APPROVING / SIGNED（非字典驱动） */
  status?: string | null;
  /** `Contract.execStatus`（dict contract_execution_status） */
  execStatus?: string | null;
  /** `ContractExt.currentPayRatio`（0..1；null = 推不出来，超付规则据此**不报**） */
  currentPayRatio?: unknown;
  /** 合同链父级（补充协议指向主合同）；规则层据此把「结算量 / 清单量」对齐到链根 */
  parentContractId?: string | null;
}

export interface SettlementItemRow {
  materialBaseId: string;
  qty?: unknown;
  totalWithTax?: unknown;
}

export interface SettlementRow {
  id: string;
  contractId?: string | null;
  code?: string | null;
  amount?: unknown;
  actualAmount?: unknown;
  settleDate?: unknown;
  statusCode?: string | null;
  items?: SettlementItemRow[];
}

export interface PaymentRow {
  id: string;
  contractId?: string | null;
  amount?: unknown;
  payDate?: unknown;
  payMonth?: string | null;
  statusCode?: string | null;
}

export interface InvoiceRow {
  id: string;
  settlementId?: string | null;
  amountWithTax?: unknown;
  statusCode?: string | null;
  invoiceNo?: string | null;
}

export interface ProcedureRow {
  id: string;
  code?: string | null;
  contractId?: string | null;
  settleCumAmount?: unknown;
  paidCumAmount?: unknown;
  payDate?: unknown;
}

export interface ReceiptRow {
  id: string;
  settlementId?: string | null;
  orderDate?: unknown;
}

export interface FinalSettlementItemRow {
  id: string;
  finalSettlementId: string;
  settlementId?: string | null;
  settleMonth?: string | null;
  amount?: unknown;
}

export interface MaterialQtyRow {
  /** 链根合同 ID（`chainMaterialQty` 以链根为键，见 common/utils/contract-chain.ts） */
  contractId: string;
  materialBaseId: string;
  /** 合同链清单量（`ContractMaterial.qty` 按 materialBaseId 求和后传入） */
  qty?: unknown;
  name?: string | null;
}

/**
 * 一次判定的入参：**项目级**聚合（不是单合同）。
 *
 * 为什么项目级：R3（无有效合同付款）天然跨合同；其余规则内部按 `contractId` 分组。
 * 项目隔离仍由 service 的 `where: { projectId }` 保证（铁律 3），这里只是内存聚合。
 */
export interface PaymentAnomalyInput {
  contracts: ContractRow[];
  /** **判定对象**：结算日期落在所选区间内的结算单（明细类规则只认这一批） */
  settlements: SettlementRow[];
  /**
   * **累计口径**：结算日期 ≤ 区间末端的全部结算单（含区间之前的历史）。
   *
   * 累计类规则（R1-b 清单量 / R1-c 总结算引用 / R2 超付上限 / R4 票款 / R6 台账快照）
   * 必须用这一批：否则「区间内结算 + 全时段付款」互相打架，选任何区间都会把
   * 历史合规付款报成超付。缺省时退化为 `settlements`。
   */
  cumulativeSettlements?: SettlementRow[];
  /** 判定区间（`from` 用于区分「区间外」与「跨项目」；两者都可缺省） */
  window?: { from?: string | null; to?: string | null };
  payments: PaymentRow[];
  invoices: InvoiceRow[];
  procedures?: ProcedureRow[];
  receipts?: ReceiptRow[];
  finalSettlementItems?: FinalSettlementItemRow[];
  /** 合同链清单量（按 materialBaseId 聚合）；缺省 = 没有上限口径，R1-b 不报 */
  contractMaterials?: MaterialQtyRow[];
  tolerances?: Partial<AnomalyTolerances>;
}

/** 判定阈值（全部可由系统参数注入，见 `anomaly-config.ts`） */
export interface AnomalyTolerances {
  /** 金额容差（分）：差额 ≤ 此值视为「一致」 */
  amount: Cents;
  /** 数量容差（百分点，`2` = 2%） */
  qtyPct: number;
  /** 明细物资集合重合度阈值（Jaccard，0..1） */
  jaccard: number;
}

/**
 * 默认阈值：金额容差 1 元（业务允许的分位误差），数量 +2%（计量误差），
 * 明细重合度 0.8（一组明细有 8/10 重合才算「同一批」）。
 */
export const DEFAULT_TOLERANCES: AnomalyTolerances = {
  amount: 100n,
  qtyPct: 2,
  jaccard: 0.8,
};

export function resolveTolerances(partial?: Partial<AnomalyTolerances>): AnomalyTolerances {
  return {
    amount: partial?.amount ?? DEFAULT_TOLERANCES.amount,
    qtyPct: partial?.qtyPct ?? DEFAULT_TOLERANCES.qtyPct,
    jaccard: partial?.jaccard ?? DEFAULT_TOLERANCES.jaccard,
  };
}

/** 命中汇总（面板顶部的风险摘要卡；也进通知正文） */
export interface AnomalySummary {
  total: number;
  high: number;
  medium: number;
  byCode: Partial<Record<AnomalyCode, number>>;
}

/**
 * 一次判定的完整结果。
 *
 * `notEvaluated` 是**诚实性要求**：某条规则因缺口径而没跑（例如合同没有付款比例），
 * 必须显式说出来，而不是静默返回「无异常」。面板与 LLM 提示词都要带上它，
 * 避免「0 命中」被误读成「账没问题」（这是财务类 AI 最危险的误读）。
 */
export interface AnomalyEvaluation {
  findings: Finding[];
  summary: AnomalySummary;
  notEvaluated: string[];
}
