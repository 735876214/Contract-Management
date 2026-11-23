/**
 * 展示层数值格式化（零依赖，前后端共用）。
 * 只负责"怎么显示"，任何参与落库/比较的数值必须先走 money.ts / amounts.ts 的原语。
 */
import { num } from './numeric';
import { round } from './money';

/** 金额：千分位 + 2 位小数；空值返回空串（0 正常显示 0.00） */
export function fmtAmount(v: unknown): string {
  const n = num(v);
  if (n === null) return '';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 数量：整数原样、小数去掉多余的 0；空值返回空串 */
export function fmtQty(v: unknown): string {
  const n = num(v);
  return n === null ? '' : String(n);
}

/** 比率：百分比保留 2 位小数；入参本身已是百分数数值（12.34 → 12.34%） */
export function fmtRate(v: unknown, digits = 2): string {
  const n = num(v);
  if (n === null) return '';
  const r = round(n, digits);
  if (r === null) return '';
  return `${r.toFixed(digits)}%`;
}

/** 万元金额格式：与 fmtAmount 同口径 */
export const fmtWan = fmtAmount;
