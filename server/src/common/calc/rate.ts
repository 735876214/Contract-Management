/**
 * 税率与比率单位换算（零依赖，前后端共用）。
 *
 * 系统里长期并存两种口径，必须靠显式函数名区分，禁止用 `>1 ? /100 : x` 猜单位：
 * - Contract.taxRate / Invoice.taxRate：小数（0.13 = 13%）
 * - ContractMaterial.taxRatePct / ReceiptOrderDetail.taxRate：百分比数值（13 = 13%）
 */
import { round, round2 } from './money.ts';
import { num } from './numeric.ts';

/** 小数税率 → 百分比数值：0.13 → 13（原内联式 Math.round(frac*10000)/100） */
export function rateToPct(rate: unknown): number | null {
  const r = num(rate);
  return r === null ? null : round(r * 100, 2);
}

/** 百分比数值 → 小数税率：13 → 0.13 */
export function pctToRate(pct: unknown): number | null {
  const p = num(pct);
  return p === null ? null : round(p / 100, 4);
}

/** 占比（%）= numerator / denominator × 100；分母为 0 返回 0（沿用 helpers.ratio 口径） */
export function ratio(numerator: unknown, denominator: unknown): number {
  const d = num(denominator);
  if (!d) return 0;
  return round2(((num(numerator) ?? 0) / d) * 100);
}

/** 差额比率（%）=（基准 − 成交）/ 基准 × 100；基准缺失或为 0 → null（表示不可计算） */
export function calcRateNullable(base: unknown, deal: unknown): number | null {
  const b = num(base);
  const d = num(deal);
  if (b === null || b === 0 || d === null) return null;
  return round2(((b - d) / b) * 100);
}
