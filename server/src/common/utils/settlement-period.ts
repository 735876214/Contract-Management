/**
 * **月度结算期**与**月份归集**的纯函数（零依赖）。
 *
 * 业务口径（2026-10-16 澄清）：
 * - 项目上填「月度结算起始日期」，其**日**即每期的起始日；
 * - **每期 = 起始日 → 下月同日的前一日**（例：起始日 = 每月 1 日 → 9/1–9/30）；
 * - 自动生成结算抓的是**上一期**（例：10/2 运行时抓 9/1–9/30 生成 9 月结算）。
 *
 * 两处刻意的选择（业务没给反例，在此写明并锁定）：
 *
 * 1. **跨月的起始日（如 26 日）**：期 = 10/26–11/25，采用**期末所在月份**做标签（'2026-11'），
 *    因为该期的收领单绝大多数落在 11 月、期末也在 11 月。起始日为 1 日时（业务给的那个例子）
 *    期初与期末同月，两种口径结果相同 —— 即此选择与业务例子并不冲突。
 *    ⚠️ 因此**结算单的 `settleDate` 应写期末**：台账的 `settleMonth` 由 `settleDate` 派生，
 *    两边必须同口径，否则自动生成的结算单会挂到相邻月份的台账行上。
 * 2. **起始日 29/30/31**：该月没有这一日时**取该月最后一天**（1/31 的下期起始 = 2/28），
 *    故「相邻两期严格等长」在小月附近不成立 —— 这是所有"按日锚定"日历规则的共同代价，
 *    比"跳过小月"或"回落到 1 日"更可预期。
 *
 * ⚠️ 必须保持零依赖（不得有任何 `import`）：由 `.mts` spec 直接引用。
 */

/** 月份键，`YYYY-MM` */
export type MonthKey = string;

/** 数字补零 */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 某年某月（`monthIndex` 为 0 基）的天数 */
const daysInMonth = (year: number, monthIndex: number): number => new Date(year, monthIndex + 1, 0).getDate();

/**
 * 日期 → 月份键 `YYYY-MM`（本地时区，与台账 `settleMonth` 同口径）。
 * 空值 / 非法日期 → `null`（**不是**空串：调用方要能区分"没有"与"解析失败"）。
 *
 * 形参取 `unknown`：调用方常直接把手里的任意值（Prisma 字段、请求体、`any`）丢进来，
 * 让每个调用点各自断言类型只会把噪音摊开，这里统一做兜底。
 */
export function monthKey(d: unknown): MonthKey | null {
  if (d === null || d === undefined || d === '') return null;
  const dt = d instanceof Date ? d : new Date(d as any);
  if (isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
}

/**
 * 「结算账期」这类**自由文本** → 月份键。发票的 `settlePeriod` 是手工输入的长文本字段
 * （页面是普通输入框，历史数据里什么写法都有），故这里做容错解析：
 * `2026-09` / `2026/9` / `2026.09` / `2026年9月` / `202609` / `2026-09-01` 都能认出来。
 * 认不出 → `null`（调用方回落到按开票日期归集）。
 */
export function periodMonthKey(text: string | null | undefined): MonthKey | null {
  if (!text) return null;
  const s = String(text).trim();
  // 年 + 分隔符（- / . 年月）+ 月
  let m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})/);
  if (!m) {
    // 纯 6 位：202609
    m = s.match(/^(\d{4})(\d{2})$/);
  }
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!y || !mo || mo < 1 || mo > 12) return null;
  return `${y}-${pad2(mo)}`;
}

/** 该期起始日（项目上填的「月度结算起始日期」的日，1~31） */
export function startDayOf(startDate: Date | string | null | undefined): number {
  const d = startDate ? (startDate instanceof Date ? startDate : new Date(startDate)) : null;
  if (!d || isNaN(d.getTime())) return 1;
  return d.getDate();
}

export interface SettlementPeriod {
  /** `YYYY-MM`，取**期末**所在月份（见文件头「刻意的选择 1」） */
  month: MonthKey;
  /** 期初（含），当天 00:00 */
  start: Date;
  /** 期末（含），当天 00:00 —— 也是自动生成时写进结算单 `settleDate` 的值 */
  end: Date;
  /** 下期起始日（**不含**）—— 数据库范围查询用 `gte: start, lt: endExclusive` */
  endExclusive: Date;
}

/** 某个年月的期初：`startDay` 超过该月天数时取月末（见文件头「刻意的选择 2」） */
function periodStart(year: number, monthIndex: number, startDay: number): Date {
  const day = Math.min(Math.max(startDay || 1, 1), daysInMonth(year, monthIndex));
  return new Date(year, monthIndex, day);
}

/** 由上一步的「期初 + 下期期初」组装一期 */
function buildPeriod(start: Date, nextStart: Date): SettlementPeriod {
  const end = new Date(nextStart.getTime());
  end.setDate(end.getDate() - 1);
  return { month: monthKey(end) as MonthKey, start, end, endExclusive: nextStart };
}

/**
 * `refDate` **所在**的那一期（例：起始日 1 日、refDate = 10/2 → 10/1–10/31）。
 */
export function currentSettlementPeriod(startDay: number, refDate: Date | string): SettlementPeriod {
  const ref = refDate instanceof Date ? refDate : new Date(refDate);
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const thisStart = periodStart(y, m, startDay);
  if (ref.getTime() >= thisStart.getTime()) {
    // 已过本月起始日 → 本期从本月起始日开始
    return buildPeriod(thisStart, periodStart(y, m + 1, startDay));
  }
  // 还没到本月起始日 → 本期从**上月**起始日开始
  const prevStart = periodStart(y, m - 1, startDay);
  return buildPeriod(prevStart, thisStart);
}

/**
 * `refDate` **之前**的那一期 —— **自动生成结算抓的就是它**
 * （业务例：10/2 运行时抓 9/1–9/30 生成 9 月结算）。
 */
export function previousSettlementPeriod(startDay: number, refDate: Date | string): SettlementPeriod {
  const cur = currentSettlementPeriod(startDay, refDate);
  // 本期的期初往前挪一天，就落在上一期里
  const dayBefore = new Date(cur.start.getTime());
  dayBefore.setDate(dayBefore.getDate() - 1);
  return currentSettlementPeriod(startDay, dayBefore);
}

/**
 * 某日期落在**哪一期**（返回该期的 `month` 标签）—— 判「同一结算期」就用它比较两个日期。
 *
 * 为什么不用 `monthKey()`（自然月）判归属：起始日不是 1 日时，期末与自然月**错开**
 * （起始日 26 日 → 期 9/26–10/25 属于 10 月），一张 9/28 的单据与期末 10/25 的结算单
 * 本来就该归到一起；用自然月比会把它们判成"不同月"而拒绝关联。
 * 起始日 = 1 日时两者等价（业务给的例子就是这个情形）。
 */
export function periodKeyOf(startDay: number, date: unknown): MonthKey | null {
  if (date === null || date === undefined || date === '') return null;
  const d = date instanceof Date ? date : new Date(date as any);
  if (isNaN(d.getTime())) return null;
  return currentSettlementPeriod(startDay, d).month;
}

/**
 * 本地口径的 `YYYY-MM-DD` —— **接口边界上的日期一律用它输出**。
 *
 * 为什么不能直接把 `Date` 丢给 JSON：`currentSettlementPeriod()` 这些用 `new Date(y, m, d)`
 * 构造的是**本地时刻**，序列化成 ISO 会按 **UTC** 输出（容器 TZ 为 CST 时，本地 9/1 00:00
 * 变成 `2026-08-31T16:00:00.000Z`），而前端按全站惯例 `String(v).slice(0, 10)` 显示
 * → **差一天**（2026-10-16 真渲染验收时实测到：「结算期 2026-08-31 ~ 2026-09-29」）。
 * 输出成字符串后，前端无需做任何时区换算，与 `settleDate` 等既有字段的展示口径也一致。
 */
export function formatDay(d: unknown): string | null {
  if (d === null || d === undefined || d === '') return null;
  const dt = d instanceof Date ? d : new Date(d as any);
  if (isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
