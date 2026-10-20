/**
 * 导入用的「原始单元格 → 结构化值」解析（第 9 轮审计新增）。
 *
 * 为什么单独一个文件：Excel 导入的日期与字典项过去是各模块各写一行
 * （`r['开票日期'] ? new Date(r['开票日期']) : null`、`items.find(...)?.itemCode || null`），
 * 带来两类静默错误：
 *
 * 1. **日期**：`new Date('2026-13-01')` 得到 Invalid Date，写库时 Prisma 抛原始错误、
 *    整批事务回滚，异步导入只会把 Prisma 原文塞进 task.message，用户看不到是哪一行；
 *    更坏的是数字时间格式的单元格被解析成 Excel 序列号（45000）→ `new Date(45000)` 静默变成 1970-01-01。
 * 2. **字典项**：名称没命中就返回 null，直接写进库是 NULL —— 单据类别/状态丢了，界面还提示导入成功。
 *
 * 这里只做纯函数，不抛业务异常（调用方决定用 `RowError` 还是 400），
 * 便于被 `server/test/*.spec.ts` 直接加载。
 */

/** 允许的日期范围：低于 1900 或高于 2100 基本可以断定是解析错了 */
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/** Excel 序列号的基准日（Excel 把 1900-01-01 记为 1，且包含不存在的 1900-02-29，故以 1899-12-30 为 0） */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

export interface ParsedDate {
  date: Date | null;
  /** 有值表示解析失败；调用方应把它变成行级错误 */
  error?: string;
}

/** 归一化中文/斜杠日期写法：`2026年1月31日` / `2026/1/31` / `2026.1.31` → `2026-1-31` */
function normalizeDateText(raw: string): string {
  return raw
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/[./]/g, '-')
    .replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '')
    .trim();
}

/** 数字序列号 → 日期（Excel 日期格被读成数字时的兜底） */
function fromExcelSerial(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = EXCEL_EPOCH_UTC + Math.round(serial) * 86400000;
  const d = new Date(ms);
  // 用 UTC 取年月日再按本地零点重建，避免容器时区导致跨天
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 解析导入行里的日期单元格。
 * @param value 原始单元格值（string / number / Date）
 * @param field 列名，用于错误文案
 */
export function parseImportDate(value: unknown, field = '日期'): ParsedDate {
  if (value === null || value === undefined) return { date: null };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { date: null, error: `「${field}」不是有效日期` };
    const y = value.getFullYear();
    if (y < MIN_YEAR || y > MAX_YEAR) {
      return { date: null, error: `「${field}」的年份（${y}）超出范围（${MIN_YEAR}–${MAX_YEAR}）` };
    }
    return { date: value };
  }

  if (typeof value === 'number') {
    const d = fromExcelSerial(value);
    if (!d) return { date: null, error: `「${field}」不是有效日期（收到数字 ${value}）` };
    const y = d.getFullYear();
    if (y < MIN_YEAR || y > MAX_YEAR) return { date: null, error: `「${field}」的年份（${y}）超出范围` };
    return { date: d };
  }

  const text = String(value).trim();
  if (!text || text === '-' || text === '—' || text === '/') return { date: null };

  // 纯数字文本：可能是 Excel 序列号，也可能有人只填了年份（那属于填错）
  if (/^\d+(\.\d+)?$/.test(text)) {
    const d = fromExcelSerial(Number(text));
    if (d) {
      const y = d.getFullYear();
      if (y >= MIN_YEAR && y <= MAX_YEAR) return { date: d };
    }
    return { date: null, error: `「${field}」不是有效日期：请填 2026-01-31 这样的日期` };
  }

  const normalized = normalizeDateText(text);
  const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) {
    return { date: null, error: `「${field}」不是有效日期（收到「${text}」）：请填 2026-01-31 这样的日期` };
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const built = new Date(y, mo - 1, d);
  // 回读比对：`2026-02-30` 会被 Date 顺延成 3-2，这里必须判出来
  if (built.getFullYear() !== y || built.getMonth() !== mo - 1 || built.getDate() !== d) {
    return { date: null, error: `「${field}」不是真实存在的日期（收到「${text}」）` };
  }
  if (y < MIN_YEAR || y > MAX_YEAR) {
    return { date: null, error: `「${field}」的年份（${y}）超出范围（${MIN_YEAR}–${MAX_YEAR}）` };
  }
  return { date: built };
}

/**
 * 导入行里的字典名称/编码 → 字典项编码。
 * 空单元格返回 null（允许留空）；**非空但没命中同样返回 null**，
 * 由调用方决定报错（原先直接写 NULL，单据类别会静默丢失）。
 */
export function pickDictCode(items: any[], value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const hit = (items || []).find((i: any) => i.itemName === text || i.itemCode === text);
  return hit?.itemCode || null;
}
