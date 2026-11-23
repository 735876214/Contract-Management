/**
 * AI 模块共享的展示格式（零依赖）：金额千分位、变化率文案。
 * 报告 Markdown、工作簿、采集器摘要共用，避免同一算法各写一份。
 */

export const formatYuan = (n: number): string =>
  Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatPct = (v: number | null): string => (v === null ? '—' : `${v}%`);

/** 变化率：参照期 null → `—`；参照期 0 → 本期 0 记 0%，否则 `—`（不编百分比） */
export function changeRateText(
  now: number,
  prev: number | null,
  opts: { sign?: boolean; empty?: string } = {},
): string {
  const empty = opts.empty ?? '—';
  if (prev === null) return empty;
  if (prev === 0) return now === 0 ? '0%' : empty;
  const pct = Math.round(((now - prev) / prev) * 10000) / 100;
  const sign = pct > 0 && opts.sign !== false ? '+' : '';
  return `${sign}${pct}%`;
}
