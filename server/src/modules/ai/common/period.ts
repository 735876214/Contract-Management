/**
 * AI 经营数据助手 · **期间原语（纯函数）**。
 *
 * 从 `ReportService` 抽出并补齐同比（业务 2026-11-12 确认环比/同比单选）：
 * - 日期一律按**本地零点**解析（`YYYY-MM-DDT00:00:00`），容器 `TZ=Asia/Shanghai`；
 *   不能写 `new Date('YYYY-MM-DD')`（按 UTC 解析，首日 00:00–08:00 静默漏计）；
 * - 对比期：`mom` = 紧邻本期之前、等长的一段；`yoy` = 起点/终点各回退一年；
 * - `all`（累计至今）没有起点，也没有对比期 → `null`，展示为 `-`，**不当作下降 100%**。
 */

import type { AiCompareMode, AiPeriodPreset } from '../analytics/analytics.types.ts';

export interface DayRange {
  /** `all`（累计至今）时没有起点；其余预设必有起点 */
  from: Date | null;
  to: Date;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地日期键 `YYYY-MM-DD`（按进程时区，与 `helpers.localDayKey` 同口径） */
export function localDayKey(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地月份键 `YYYY-MM` */
export function localMonthKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** `YYYY-MM-DD` → 本地零点；非法返回 `null`（由调用方转成 400） */
export function parseLocalDay(v: string | undefined | null): Date | null {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 预设期间 → 日期范围。`now` 由上层注入（纯函数不读系统时钟，单测可固定）。
 * `custom` 必须同时给出合法的 `from` / `to`，否则返回 `null`。
 */
export function resolvePresetPeriod(
  preset: AiPeriodPreset,
  now: Date,
  custom?: { from?: string; to?: string },
): DayRange | null {
  const today = endOfDay(now);
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case 'this_month':
      return { from: new Date(y, m, 1), to: today };
    case 'last_month':
      return { from: new Date(y, m - 1, 1), to: endOfDay(new Date(y, m, 0)) };
    case 'this_quarter': {
      const qStart = Math.floor(m / 3) * 3;
      return { from: new Date(y, qStart, 1), to: today };
    }
    case 'this_year':
    case 'ytd':
      return { from: new Date(y, 0, 1), to: today };
    case 'last_30_days': {
      const from = new Date(now);
      from.setDate(from.getDate() - 29);
      return { from: startOfDay(from), to: today };
    }
    case 'last_90_days': {
      const from = new Date(now);
      from.setDate(from.getDate() - 89);
      return { from: startOfDay(from), to: today };
    }
    case 'all':
      return { from: null, to: today };
    case 'custom': {
      const from = parseLocalDay(custom?.from);
      const to = parseLocalDay(custom?.to);
      if (!from || !to || from > to) return null;
      return { from, to: endOfDay(to) };
    }
    default:
      return null;
  }
}

/**
 * 对比期：`mom` 紧邻本期之前、等长；`yoy` 起止各回退一年。
 * `all`（无起点）、`none`、或推不出参照期 → `null`。
 */
export function compareRange(range: DayRange, mode: AiCompareMode): DayRange | null {
  if (mode === 'none' || !range.from) return null;
  if (mode === 'mom') {
    const spanMs = range.to.getTime() - range.from.getTime();
    const cmpTo = new Date(range.from.getTime() - 1);
    const cmpFrom = new Date(cmpTo.getTime() - spanMs);
    return { from: cmpFrom, to: cmpTo };
  }
  // yoy：起止各回退一年（2 月 29 日等边界由 Date 自行归一）
  const from = new Date(range.from);
  from.setFullYear(from.getFullYear() - 1);
  const to = new Date(range.to);
  to.setFullYear(to.getFullYear() - 1);
  return { from, to };
}

/** 期间的展示文案；`all` 写明「累计至今（截至…）」 */
export function rangeLabel(range: DayRange): string {
  if (!range.from) return `累计至今（截至 ${localDayKey(range.to)}）`;
  return `${localDayKey(range.from)} ~ ${localDayKey(range.to)}`;
}

/** 区间是否包含某业务日期（`null` 日期：累计至今时计入，限定期间时不计——与 DB 的 gte/lte 同口径） */
export function inRange(v: Date | string | null | undefined, range: DayRange): boolean {
  if (!v) return range.from === null;
  if (!range.from) return true;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  if (d < range.from) return false;
  return d <= range.to;
}
