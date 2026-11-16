/**
 * AI 预警 · **SysParam 文本解析原语**。
 *
 * 系统参数是「人填的字符串」：`1`/`true`/`开`、`20%`、空串、手滑写成 `2000`……
 * 解析失败一律返回 `null`，由调用方决定回落默认值并记一条 `problems`，
 * **绝不因一条参数写错让整个预警接口 500**。
 */

/** 布尔开关：`1/true/on/yes/y` → true；`0/false/off/no/n` → false；其余 → null */
export function parseBoolFlag(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (['1', 'true', 'on', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(s)) return false;
  return null;
}

/** 十进制数（容忍千分位与首尾空白、容忍尾部 `%`）：非法 → null */
export function parseDecimal(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw)
    .trim()
    .replace(/,/g, '')
    .replace(/%$/, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 整数（用于「家数」「基点」这类不该有小数小数的阈值）：小数四舍五入。非法 → null。
 * 命名避开全局 parseInt，避免调用处无意间拿到同名函数。
 */
export function parseInteger(raw: unknown): number | null {
  const n = parseDecimal(raw);
  if (n === null) return null;
  return Math.round(n);
}

/** 区间夹逼：`clamp(n, min, max)`，越界即夹到边界（不做静默丢弃，边界值仍有效） */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
