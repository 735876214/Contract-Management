/**
 * AI 预警 · **采购报价与价差**（矩阵课题 3-9）—— 判定口径、类型与容差。
 *
 * == 与 6-9 同一套架构 ==
 * 这一层是**纯函数**：不 import Prisma、不做 IO、不认识 HTTP，能被 `npm test` 裸跑。
 * 判定在程序里算完，交给 LLM 的只有 `facts` 里已经算好的字符串（与 `ai/report.service.ts`
 * 的「程序算数、模型说话」同一口径，理由见 `.claude/rules/backend-conventions.md`）。
 *
 * == 事实源（别读 JSON 快照）==
 * `.claude/rules/procurement-and-tender.md`：`ProcurementBidder` 的**结构化行**是单位与两轮报价的
 * 事实源，`ProcurementResultReport.suppliers` 的 JSON 只是发布快照。所以本层只吃 bidder 行；
 * 单价口径取 `ProcurementTotalItem`（控制价 `planPrice` / 市场价 `marketPrice` / 信息价 `infoPrice`）
 * 与 `ProcurementPriceCompare.items` 里的 `dealPrice`（成交价不含税单价，用户录入）。
 *
 * == 金额一律走整数分 ==
 * 见 `ai/common/money.ts`：`Decimal(18,2)` × 100 会越过 `MAX_SAFE_INTEGER`，浮点比较会在
 * 「恰好等于上限」这类边界上给出相反结论。数量（`Float`）先按 4 位小数定成 `Units` 再乘。
 */

import { BIDDER_STATUS } from '../../../constants/statuses.ts';
import {
  type Cents,
  type Units,
  amountOfUnits,
  centsToYuan,
  moneyToCents,
  parseScaled,
  qtyToUnits,
} from '../common/money.ts';

/** 风险等级（沿用 6-9 的两级：业务只区分「必须马上看」与「复核一下」） */
export const QUOTE_LEVEL = { HIGH: 'HIGH', MEDIUM: 'MEDIUM' } as const;
export type QuoteLevel = (typeof QUOTE_LEVEL)[keyof typeof QUOTE_LEVEL];

export const QUOTE_LEVEL_LABELS: Record<QuoteLevel, string> = {
  HIGH: '高风险',
  MEDIUM: '需复核',
};

/**
 * 规则码（**单一事实源**）。B1–B7 对应 `docs/AI应用落地计划.md` §2.3 的七类形态：
 * 两轮降幅 → 报价离散度 → 成交价与预算 → 单价与市场价 → 税率 → 定标合理性 → 参标完整性。
 */
export const QUOTE_CODES = {
  /** B1-a 二轮降幅超阈值（先虚高再降价的典型形态，需复核报价合理性） */
  B1_DROP_EXCESS: 'B1_DROP_EXCESS',
  /** B1-b 二轮报价高于一轮（议价方向异常，多为录入或口径错误） */
  B1_DROP_INVERTED: 'B1_DROP_INVERTED',
  /** B2 首轮报价高度一致（离散系数过低，围标迹象，需复核） */
  B2_SPREAD_TOO_LOW: 'B2_SPREAD_TOO_LOW',
  /** B3-a 成交价超控制价合计（超预算成交） */
  B3_OVER_BUDGET: 'B3_OVER_BUDGET',
  /** B3-b 成交价显著低于控制价合计（漏项 / 范围缩水复核） */
  B3_UNDER_BUDGET: 'B3_UNDER_BUDGET',
  /** B4-a 清单行成交单价高于控制价单价 */
  B4_PRICE_OVER_CONTROL: 'B4_PRICE_OVER_CONTROL',
  /** B4-b 清单行成交单价偏离市场价 / 信息价 */
  B4_PRICE_VS_MARKET: 'B4_PRICE_VS_MARKET',
  /** B5-a 税率不在常用税率集合（税金与不含税总额不自洽） */
  B5_TAX_RATE_INVALID: 'B5_TAX_RATE_INVALID',
  /** B5-b 两轮报价税率不一致（口径混用） */
  B5_TAX_RATE_DRIFT: 'B5_TAX_RATE_DRIFT',
  /** B6 成交价高于同任务最低有效报价（定标理由需补充说明） */
  B6_NOT_LOWEST: 'B6_NOT_LOWEST',
  /** B7-a 有效报价家数不足 */
  B7_FEW_BIDDERS: 'B7_FEW_BIDDERS',
  /** B7-b 中标单位没有可用报价 */
  B7_WINNER_NO_PRICE: 'B7_WINNER_NO_PRICE',
} as const;
export type QuoteCode = (typeof QUOTE_CODES)[keyof typeof QUOTE_CODES];

export const QUOTE_CODE_LABELS: Record<QuoteCode, string> = {
  B1_DROP_EXCESS: '二轮降幅超阈值',
  B1_DROP_INVERTED: '二轮报价高于一轮',
  B2_SPREAD_TOO_LOW: '首轮报价高度一致',
  B3_OVER_BUDGET: '成交价超控制价',
  B3_UNDER_BUDGET: '成交价显著低于控制价',
  B4_PRICE_OVER_CONTROL: '单行成交单价超控制价',
  B4_PRICE_VS_MARKET: '单价偏离市场价',
  B5_TAX_RATE_INVALID: '税率不在常用集合',
  B5_TAX_RATE_DRIFT: '两轮税率不一致',
  B6_NOT_LOWEST: '成交价非最低有效报价',
  B7_FEW_BIDDERS: '有效报价家数不足',
  B7_WINNER_NO_PRICE: '中标单位缺报价',
};

/** 命中对象类型（决定前端「点进去看什么」） */
export const QUOTE_ENTITY_LABELS = {
  task: '采购任务',
  bidder: '响应单位',
  totalItem: '清单行',
} as const;
export type QuoteEntity = keyof typeof QUOTE_ENTITY_LABELS;

/** 常用增值税率（百分点）。高于/低于容差即视为税金与不含税总额不自洽 */
export const LEGAL_TAX_RATE_PCT = [0, 1, 3, 5, 6, 9, 11, 13] as const;

/** 1% = 100 基点。比例统一用「基点」整数表达，避免浮点在边界上翻向 */
export const QUOTE_PCT = 100;

/** 采购任务（只需判定用到的列） */
export interface TaskRow {
  id: string;
  taskNo?: string | null;
  name?: string | null;
  status?: string | null;
  stage?: string | null;
}

/** 响应单位（`ProcurementBidder`）——两轮报价与税金为事实源 */
export interface BidderRow {
  id: string;
  taskId?: string | null;
  bidderName?: string | null;
  seq?: number | null;
  firstPreTaxTotal?: unknown;
  firstTax?: unknown;
  secondPreTaxTotal?: unknown;
  secondTax?: unknown;
  finalPreTaxTotal?: unknown;
  status?: string | null;
  passedFirst?: string | null;
}

/** 总采购清单行（`ProcurementTotalItem`）：qty/单价均为原样值（Float/Decimal 皆可） */
export interface TotalItemRow {
  id: string;
  taskId?: string | null;
  materialBaseId?: string | null;
  materialName?: string | null;
  spec?: string | null;
  unit?: string | null;
  qty?: unknown;
  planPrice?: unknown;
  marketPrice?: unknown;
  infoPrice?: unknown;
  stdCost?: unknown;
  incomePrice?: unknown;
  sortOrder?: number | null;
}

/**
 * 采购价格对比表明细行（`ProcurementPriceCompare.items` 的 JSON，**已解析**）。
 * 只有 `dealPrice` / `remark` 是用户录入，其余列由总清单派生——但派生列也可能为空，
 * 所以判定时仍以行内值为准，缺失就跳过（「未填 ≠ 0」）。
 */
export interface CompareItemRow {
  materialBaseId?: string | null;
  materialName?: string | null;
  spec?: string | null;
  unit?: string | null;
  qty?: unknown;
  planPrice?: unknown;
  marketPrice?: unknown;
  infoPrice?: unknown;
  dealPrice?: unknown;
  remark?: string | null;
}

/** 一个采购任务的全部输入 */
export interface QuoteTaskInput {
  task: TaskRow;
  bidders: BidderRow[];
  /** 总采购清单行（控制价 / 市场价 / 信息价 + 数量） */
  items?: TotalItemRow[];
  /** 价格对比表明细（成交单价） */
  compareItems?: CompareItemRow[];
  tolerances?: Partial<QuoteTolerances>;
}

export interface QuoteInput {
  tasks: QuoteTaskInput[];
  tolerances?: Partial<QuoteTolerances>;
}

/** 阈值。全部可通过 `SysParam` 覆盖（`ai.quote.*`），默认值即本表 */
export interface QuoteTolerances {
  /** 金额比较的绝对容差（分）：**恰好等于上限不算超**（`amount-guard.ts` 的口径） */
  amount: Cents;
  /** 二轮降幅上限（百分点）。超过即复核是否先虚高再降价 */
  dropPct: number;
  /** 首轮报价离散系数下限（百分点）。低于即视为「高度一致」 */
  spreadPct: number;
  /** 成交价 / 控制价合计的下限（百分点）。低于即复核漏项与范围 */
  underBudgetPct: number;
  /** 成交单价偏离市场价的上限（百分点） */
  priceDevPct: number;
  /** 税率比较容差（基点）：30 = 0.30 个百分点 */
  taxRateToleranceBp: number;
  /** 有效报价家数下限 */
  minBidders: number;
}

export const DEFAULT_QUOTE_TOLERANCES: QuoteTolerances = {
  amount: 100n, // 1 元
  dropPct: 20,
  spreadPct: 3,
  underBudgetPct: 70,
  priceDevPct: 15,
  taxRateToleranceBp: 30,
  minBidders: 3,
};

/** 合并调用方传入的容差；非法值（负数 / NaN / 非整数家数）按默认值兜底，不抛错 */
export function resolveQuoteTolerances(partial?: Partial<QuoteTolerances>): QuoteTolerances {
  const base = DEFAULT_QUOTE_TOLERANCES;
  if (!partial) return base;
  const money = partial.amount === undefined ? base.amount : BigInt(partial.amount);
  const pct = (v: number | undefined, def: number, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
  };
  return {
    amount: money < 0n ? base.amount : money,
    dropPct: pct(partial.dropPct, base.dropPct, 0, 100),
    spreadPct: pct(partial.spreadPct, base.spreadPct, 0, 100),
    underBudgetPct: pct(partial.underBudgetPct, base.underBudgetPct, 0, 100),
    priceDevPct: pct(partial.priceDevPct, base.priceDevPct, 0, 100),
    taxRateToleranceBp: Math.round(pct(partial.taxRateToleranceBp, base.taxRateToleranceBp, 0, 5000)),
    minBidders: Math.round(pct(partial.minBidders, base.minBidders, 1, 20)),
  };
}

/** 一条命中。`facts` 是**已算好的**中文事实（模型只许照抄与措辞，不许再算） */
export interface QuoteFinding {
  code: QuoteCode;
  level: QuoteLevel;
  entity: QuoteEntity;
  entityId: string;
  taskId: string;
  taskNo: string;
  title: string;
  facts: string[];
  /** 涉及的金额差额（元字符串，正数；方向写在 title/facts 里） */
  amountDiff?: string;
}

export interface QuoteSummary {
  total: number;
  high: number;
  medium: number;
  byCode: Record<string, number>;
}

export interface QuoteEvaluation {
  findings: QuoteFinding[];
  summary: QuoteSummary;
  /** 无法判定的规则与原因（口径透明度：漏判要说出来，不能静默当「没问题」） */
  notEvaluated: string[];
}

// ---------------------------------------------------------------- 取值与格式

/** 金额原语转出（供规则层与外部调用方共用同一套口径） */
export { amountOfUnits, centsToYuan, moneyToCents, parseScaled, qtyToUnits };
export type { Cents, Units };

export function bidderFirstCents(b: BidderRow): Cents | null {
  return moneyToCents(b.firstPreTaxTotal);
}

export function bidderSecondCents(b: BidderRow): Cents | null {
  return moneyToCents(b.secondPreTaxTotal);
}

export function bidderFinalCents(b: BidderRow): Cents | null {
  return moneyToCents(b.finalPreTaxTotal);
}

/**
 * 「可用报价」：最终确认价 → 第二轮 → 第一轮。
 * 定标时服务端只写 `finalPreTaxTotal`；只导入过两轮报价（未定标）的行没有 final。
 */
export function bidderTotalCents(b: BidderRow): Cents | null {
  return bidderFinalCents(b) ?? bidderSecondCents(b) ?? bidderFirstCents(b);
}

/** 首轮或第二轮有正数报价，且未弃标 —— 计入「有效报价家数」 */
export function isCountedBidder(b: BidderRow): boolean {
  if (b.status === BIDDER_STATUS.ABSTAINED) return false;
  const first = bidderFirstCents(b);
  const second = bidderSecondCents(b);
  const final = bidderFinalCents(b);
  return [first, second, final].some((c) => c !== null && c > 0n);
}

/** 标的额（分）→ 元字符串 */
export const yuan = (c: Cents): string => centsToYuan(c);

/**
 * `numer/denom` → 基点（百分数 × 100），半进位。`denom <= 0` → `null`（口径未知，宁可漏报）。
 * 例：`ratioBpOf(8000n, 10000n) === 2000` 即 20.00%。
 */
export function ratioBpOf(numer: Cents, denom: Cents): number | null {
  if (denom <= 0n) return null;
  const neg = numer < 0n;
  const abs = neg ? -numer : numer;
  const q = (abs * 20_000n + denom) / (denom * 2n); // = abs/denom*10000 四舍五入
  const val = Number(q);
  return neg ? -val : val;
}

/** 基点 → `20.00%` */
export function fmtBp(bp: number): string {
  const neg = bp < 0;
  const abs = neg ? -bp : bp;
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

/** 单价的税率（基点）= 税额 / 不含税总额；任一缺失或总额非正 → `null` */
export function taxRateBpOf(preTax: Cents | null, tax: Cents | null): number | null {
  if (preTax === null || tax === null || preTax <= 0n) return null;
  return ratioBpOf(tax, preTax);
}
