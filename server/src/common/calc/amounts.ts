/**
 * 金额计算原语（零依赖，前后端共用）。
 *
 * 收敛此前散落在合同清单 / 物资 / 收领单 / 结算 / 采购各阶段的重复公式：
 * - 含税单价 = 税前单价 × (1 + 税率百分数 / 100)
 * - 含税合价 = 单价 × 数量
 * 精度由调用方显式传入（合同清单 4 位、收领单总价 2 位、结算合价 2 位），
 * 但舍入实现只有 money.ts 一份。
 */
import { round } from './money.ts';
import { num } from './numeric.ts';

/** 合价 = 单价 × 数量，默认按金额 2 位舍入；空值按 0 处理 */
export function calcAmount(price: unknown, qty: unknown, digits = 2): number {
  return round((num(price) ?? 0) * (num(qty) ?? 0), digits) ?? 0;
}

/** 含税单价 = 税前单价 × (1 + 税率百分数/100)；任一入参缺失返回 null（不臆造 0） */
export function calcPriceWithTax(priceBeforeTax: unknown, taxPct: unknown, digits = 4): number | null {
  const price = num(priceBeforeTax);
  const pct = num(taxPct);
  if (price === null || pct === null) return null;
  return round(price * (1 + pct / 100), digits);
}

/** 含税合价 = 含税单价 × 数量；任一入参缺失返回 null */
export function calcTotalWithTax(priceWithTax: unknown, qty: unknown, digits = 4): number | null {
  const price = num(priceWithTax);
  const q = num(qty);
  if (price === null || q === null) return null;
  return round(price * q, digits);
}

/** 逐项累加并在每一步舍入（与采购价格对比表表底汇总口径一致），避免浮点尾差累积 */
export function sumRounded(values: Array<number | null | undefined>, digits = 2): number {
  return values.reduce<number>((acc, v) => round(acc + (v ?? 0), digits) ?? acc, 0);
}
