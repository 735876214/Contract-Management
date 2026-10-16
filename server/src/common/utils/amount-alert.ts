/**
 * **合同金额红/黄预警的判定**（纯函数、零依赖）。
 *
 * 业务口径（2026-10-15 澄清，阈值由业务方给定）：
 *
 * | 级别 | 条件（**严格大于**，恰好等于阈值不预警） |
 * |---|---|
 * | 红 | 当前结算额 > 合同当前金额 × 110% **或** 补充协议累计金额 > 主合同金额 × 130% |
 * | 黄 | 当前结算额 > 合同当前金额 × 80% **或** 补充协议累计金额 > 主合同金额 × 110% |
 *
 * 其中「合同当前金额」= 主合同金额 + Σ 补充协议带符号增量（见 `contract-chain.ts`）。
 *
 * ⚠️ 本模块**只做展示层判定**，与防超结/防超付的金额闸门（`amount-guard.ts` +
 * `settlement.over_amount_policy` / `payment.over_amount_policy`）**互不影响**：
 * 闸门管的是"这笔单据能不能过"，预警管的是"要提醒谁去看"。
 *
 * 阈值是**业务规则**，改它就走代码 + 版本记录（不落 `sys_param`）——与 `amount-guard` 的策略
 * 参数不同，那是"策略开关"（BLOCK/WARN/OFF），这是"数轴上的界线"，混在一处容易配错。
 *
 * ⚠️ 必须保持零依赖（不得有任何 `import`）：由 `.mts` spec 直接引用。
 */

/** 阈值（倍数）。恰好等于阈值**不**预警，必须严格大于 */
export const ALERT_THRESHOLDS = {
  /** 当前结算额 / 合同当前金额 */
  settled: { red: 1.1, yellow: 0.8 },
  /** 补充协议累计金额 / 主合同金额 */
  supplement: { red: 1.3, yellow: 1.1 },
} as const;

export type AlertLevel = 'RED' | 'YELLOW';

export interface AmountAlertInput {
  /** 主合同金额；未填 → `null` */
  mainAmount: number | null;
  /** 补充协议累计（带符号） */
  supplementTotal: number;
  /** 合同当前金额 = 主合同 + 补充协议；主合同未填 → `null` */
  currentAmount: number | null;
  /** 当前累计结算额（链口径，排除草稿） */
  settledTotal: number;
}

export interface AmountAlertResult {
  /** `null` = 无预警 */
  level: AlertLevel | null;
  /** 命中的条件说明（给人看的，红在前） */
  reasons: string[];
  /** 结算额 / 合同当前金额（百分数，两位小数）；分母未知 → `null` */
  settledRatioPct: number | null;
  /** 补充协议累计 / 主合同金额（百分数，两位小数）；分母未知 → `null` */
  supplementRatioPct: number | null;
}

/** 百分数（两位小数）。⚠️ 别漏 `Number(...)`——`toFixed` 返回的是字符串 */
const pct = (numerator: number, denominator: number): number =>
  Number((((Number(numerator) || 0) / denominator) * 100).toFixed(2));

/**
 * 判定单个合同的预警级别。
 *
 * 不可计算的情形（**不误报**）：
 * - 合同当前金额未知（主合同未填金额）→ 结算比例判不了 → 该项不参与；
 * - 主合同金额未填 → 补充协议占比也判不了。
 * 两项都判不了时返回 `level: null`（宁可漏报也不误报：报表里的"未知"不能当 0）。
 */
export function evaluateAmountAlert(input: AmountAlertInput): AmountAlertResult {
  const reasons: string[] = [];
  const cur = input.currentAmount;
  const main = input.mainAmount;
  const settled = Number(input.settledTotal) || 0;
  const supplement = Number(input.supplementTotal) || 0;

  const settledRatioPct = cur ? pct(settled, cur) : null;
  const supplementRatioPct = main ? pct(supplement, main) : null;

  // —— 红：两个条件任一命中 ——
  if (cur && cur > 0 && settled > cur * ALERT_THRESHOLDS.settled.red) {
    reasons.push(`当前结算额已达合同当前金额的 ${settledRatioPct}%（超过 110%）`);
  }
  if (main && main > 0 && supplement > main * ALERT_THRESHOLDS.supplement.red) {
    reasons.push(`补充协议累计已达主合同金额的 ${supplementRatioPct}%（超过 130%）`);
  }
  if (reasons.length) return { level: 'RED', reasons, settledRatioPct, supplementRatioPct };

  // —— 黄：红未命中时再看 ——
  if (cur && cur > 0 && settled > cur * ALERT_THRESHOLDS.settled.yellow) {
    reasons.push(`当前结算额已达合同当前金额的 ${settledRatioPct}%（超过 80%）`);
  }
  if (main && main > 0 && supplement > main * ALERT_THRESHOLDS.supplement.yellow) {
    reasons.push(`补充协议累计已达主合同金额的 ${supplementRatioPct}%（超过 110%）`);
  }
  if (reasons.length) return { level: 'YELLOW', reasons, settledRatioPct, supplementRatioPct };

  return { level: null, reasons: [], settledRatioPct, supplementRatioPct };
}

/**
 * **付款超比例预警**（业务口径 2026-10-16）：开累付款 > 开累结算 × **当前生效比例** ⇒ 预警。
 *
 * 与上面那条「合同金额预警」是**两个信号**，刻意不合并：
 * - 金额预警问的是"结算/补充协议是否超出合同额"（分子是**结算**）；
 * - 本条问的是"钱是不是付早了/付多了"（分子是**付款**，比例来自付款安排）。
 * 两者都可能同时命中，工作台分列展示。
 *
 * ⚠️ 单级（不设红/黄）：业务只给了"超过就预警"这一个口径，擅自分级会让阈值变成新的未定义量。
 * ⚠️ **比例未填 / 为 0 → 一律不报**（"未填 ≠ 0"的既定原则）：比例没填时算出的上限不是 0 而是"未知"，
 * 拿 0 去比会让每一笔付款都成预警。
 * ⚠️ 开累结算为 0 → 不报：没有结算就没有"按比例应付"的基准（分母为 0 无法判定，宁漏勿误）。
 */
export interface PaymentRatioAlertInput {
  /** 开累结算额（合同链口径，排除草稿） */
  settledTotal: number;
  /** 开累付款额（合同链口径，排除失败/退款） */
  paidTotal: number;
  /** 当前生效付款比例（`ContractExt.currentPayRatio`）；未填 → `null` */
  payRatio: number | null | undefined;
}

export interface PaymentRatioAlertResult {
  exceeded: boolean;
  /** 允许的付款上限 = 开累结算 × 比例；比例未填时为 `null`（**不是 0**） */
  limit: number | null;
  /** 开累付款 / 开累结算（百分数，两位小数）；分母为 0 → `null` */
  paidRatioPct: number | null;
  /** 给人看的一句话；无预警时 `null` */
  reason: string | null;
}

export function evaluatePaymentRatioAlert(input: PaymentRatioAlertInput): PaymentRatioAlertResult {
  const settled = Number(input.settledTotal) || 0;
  const paid = Number(input.paidTotal) || 0;
  const ratio = Number(input.payRatio);
  const paidRatioPct = settled > 0 ? pct(paid, settled) : null;

  // 比例未填/为 0、或没有结算 → 无法判定（见上方两条 ⚠️）
  if (!Number.isFinite(ratio) || ratio <= 0) return { exceeded: false, limit: null, paidRatioPct, reason: null };
  if (settled <= 0) return { exceeded: false, limit: null, paidRatioPct, reason: null };

  const limit = Number((settled * ratio).toFixed(2));
  // "超过"是严格大于：恰好等于上限不算超
  if (paid <= limit) return { exceeded: false, limit, paidRatioPct, reason: null };

  const pctOfRatio = Number((ratio * 100).toFixed(2));
  return {
    exceeded: true,
    limit,
    paidRatioPct,
    reason:
      `开累付款 ${paid.toFixed(2)} 已超过「开累结算 ${settled.toFixed(2)} × 生效比例 ${pctOfRatio}%」` +
      `= ${limit.toFixed(2)}（已付占开累结算 ${paidRatioPct}%）`,
  };
}
