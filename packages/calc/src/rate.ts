/**
 * 比率计算（零依赖，前后端共用）。
 *
 * 税率全站单轨为百分数（13 = 13%，字段名统一 taxRatePct），不再有小数↔百分数双轨，
 * 因此旧的双轨换算函数 rateToPct/pctToRate 已删除。本文件只保留通用占比计算。
 */
import { round2 } from './money';
import { num } from './numeric';

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
