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
