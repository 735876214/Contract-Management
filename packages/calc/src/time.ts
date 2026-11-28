/**
 * 日期/月份原语（零依赖，前后端共用）。
 *
 * 统一本地时区口径（容器 TZ=Asia/Shanghai），禁止再用 toISOString().slice(0,10) 取业务日期：
 * UTC+8 下月初 1 号 00:00–07:59 会被写成前一天，导致同一天开的两张单落在不同月份。
 */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 纯日期串（无时间部分）。下面 `formatDay` 与 `localMidnight` 共用，必须先声明 */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 本地口径 `YYYY-MM-DD`；非法日期返回 null。
 *
 * 纯日期串（`2026-01-05`）**不经过 Date**：`new Date("2026-01-05")` 按 **UTC** 解析，
 * 在 UTC 负偏移的时区里（浏览器可能不在 +08:00）回退成前一天，而这串日期是要印在正式单据上的。
 * 这里只校验「是不是真日子」（`2026-02-30` → null），不做任何时区换算。
 */
export function formatDay(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim();
    if (DATE_ONLY_RE.test(s)) return localMidnight(s) ? s : null;
  }
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

/**
 * 纯日期串 `YYYY-MM-DD` 按**本地零点**解析。
 *
 * `new Date('2026-11-22')` 是按 **UTC** 解析的（本地 08:00），拿它当"当天开始"会让
 * 「库里存本地 00:00 的记录」落在区间外——这正是本仓禁止 `toISOString()` 取业务日期的同一类坑。
 */
function localMidnight(v: unknown): Date | null {
  if (typeof v === 'string') {
    const m = DATE_ONLY_RE.exec(v.trim());
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const day = Number(m[3]);
      const d = new Date(y, mo - 1, day);
      // 拒绝「格式对但日子不存在」：`2026-02-30` 会被 Date 静默归一成 3 月 2 日，
      // 于是「筛选到 2 月」会悄悄变成「筛选到 3 月初」（与 ai/register 的 `isRealDay` 同一口径）。
      if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
      return d;
    }
  }
  const d = toDate(v);
  if (!d) return null;
  // 复制一份：入参可能是调用方复用的 Date，纯函数不得就地改写（曾直接把入参 setHours 掉了）
  const out = new Date(d.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

/** 区间左边界：当天本地零点（含）。非法/空值返回 null，调用方应跳过该条件而不是写 `null` 进 where */
export function startOfDay(v: unknown): Date | null {
  return localMidnight(v);
}

/**
 * 区间右边界：当天本地最后一毫秒（含）。
 *
 * 列表筛选统一用它（`lte: endOfDay(endDate)`）：直接 `lte: new Date('YYYY-MM-DD')` 会把当天
 * 00:00 之后的记录全部漏掉，而各模块曾出现「有的补 23:59:59、有的不补」三种写法。
 * 更推荐 `lt: nextDayStart(endDate)`（不依赖毫秒精度），两者都在本文件实现。
 */
export function endOfDay(v: unknown): Date | null {
  const d = localMidnight(v);
  if (!d) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

/** 次日本地零点（开区间上界）：配合 `lt` 使用，跨月/跨年由 Date 自动进位 */
export function nextDayStart(v: unknown): Date | null {
  const d = localMidnight(v);
  if (!d) return null;
  d.setDate(d.getDate() + 1);
  return d;
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
