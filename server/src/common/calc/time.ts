/**
 * 日期/月份原语（零依赖，前后端共用）。
 *
 * 统一本地时区口径（容器 TZ=Asia/Shanghai），禁止再用 toISOString().slice(0,10) 取业务日期：
 * UTC+8 下月初 1 号 00:00–07:59 会被写成前一天，导致同一天开的两张单落在不同月份。
 */
const pad2 = (n: number): string => String(n).padStart(2, '0');

export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 本地口径 `YYYY-MM-DD`；非法日期返回 null */
export function formatDay(v: unknown): string | null {
  const d = toDate(v);
  if (!d) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地口径 `YYYY-MM-DD`；兼容 helpers.localDayKey 的旧签名（非法日期返回空串） */
export function localDayKey(now: Date | string | null = new Date()): string {
  // 显式传 null（DB 可空日期，如 `m.planDate`）→ 空串，不臆造今天；
  // **不传参**仍取当天（archive 文件名、采购编号等调用方依赖这个行为）。
  if (now === null) return '';
  return formatDay(now) ?? '';
}

/** 日期 → 月份键 `YYYY-MM`（本地时区） */
export function monthKey(d: unknown): string | null {
  const dt = toDate(d);
  if (!dt) return null;
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
}

/** 严格校验并归一化月份键 `YYYY-MM`；`2026-9` / `2026/09` 一律拒绝 */
export function parseMonthKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${pad2(month)}`;
}

/** 自由文本「结算账期」→ 月份键；认不出返回 null（调用方回落到按开票日期归集） */
export function periodMonthKey(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = String(text).trim();
  let m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (!Number(m[1]) || month < 1 || month > 12) return null;
  return `${m[1]}-${pad2(month)}`;
}

/** 月份键排序：零补齐后可直接字典序比较；空值排末尾 */
export function compareMonthKey(a: unknown, b: unknown): number {
  const ka = typeof a === 'string' ? a : '';
  const kb = typeof b === 'string' ? b : '';
  if (!ka && !kb) return 0;
  if (!ka) return 1;
  if (!kb) return -1;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function yearOf(v: unknown): number | null {
  return toDate(v)?.getFullYear() ?? null;
}

/** 兼容 helpers.fmtDate 的旧名称 */
export const fmtDate = formatDay;
