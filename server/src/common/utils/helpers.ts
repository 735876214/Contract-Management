/** Decimal / null 安全转 number */
export function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 求和，忽略空值 */
export function sum(list: any[], pick: (item: any) => any): number {
  return list.reduce((acc, item) => acc + (num(pick(item)) || 0), 0);
}

export function toDate(v: any): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** 格式化为 YYYY-MM */
export function monthKey(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function yearOf(v: any): number | null {
  const d = toDate(v);
  return d ? d.getFullYear() : null;
}

/** 分页参数处理 */
export function paginate(query: any = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function buildResult(list: any[], total: number, query: any = {}) {
  return {
    list,
    total,
    page: Math.max(1, Number(query.page) || 1),
    pageSize: Math.min(500, Math.max(1, Number(query.pageSize) || 20)),
  };
}

/** 百分比：分母为 0 时返回 0 */
export function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Number((((numerator || 0) / denominator) * 100).toFixed(2));
}

export function fmtDate(v: any): string | null {
  const d = toDate(v);
  if (!d) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
