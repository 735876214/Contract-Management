/**
 * 单据模板变量的**共享定义与格式化**（付款单 / 总结算单两类变量共用）。
 *
 * 2026-10-17 解除 .mts 零依赖限制后从两份各自复制的 `DocVarDef`/`formatDocMoney`/`formatDocDate`
 * 收敛而来——本模块仍保持**零第三方依赖的纯函数**（可被 .mts spec 直接加载），
 * 只是允许了 `./x.ts` 后缀的相对 import。
 */

/** 单据变量面板项（占位符名 + 说明） */
export interface DocVarDef {
  /** 占位符名（模板里写 `{{名}}`） */
  name: string;
  /** 面板里的说明 */
  desc: string;
}

/** 金额 → `1,234.56`（两位小数；空值 → 空串，让调用方决定是否保留占位符） */
export function formatDocMoney(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 日期 → `YYYY-MM-DD`（本地口径；空值 → 空串） */
export function formatDocDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const d = v instanceof Date ? v : new Date(v as any);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
