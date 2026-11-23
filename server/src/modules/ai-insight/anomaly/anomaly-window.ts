/**
 * AI 预警 · **取数期间的默认值与上限**（纯函数）。
 *
 * == 为什么单独一层（P1-4 第三阶段的落地）==
 * 预警的 9 条规则必须**逐单判定**，取数只能行级全取：成本与「区间内单据量」近似线性
 * （每 1,000 份合同 ≈ 21,000 行 / 4.6 MB / 0.33 s 查询，量测见 docs/ai-anomaly-input-cost.md）。
 * 换聚合写法省不掉行数（聚合会让规则静默失效），真正的杠杆是**把区间限死**。
 *
 * == 业务口径（2026-11-22 定，登记在 .claude/rules/product-decisions.md）==
 * - 调用方不给 `from`/`to` → 默认**近 12 个自然月**（含本月，末端到今天收尾）；
 * - 手动选区间允许覆盖项目全周期，但超过上限（默认 24 个自然月）要**先拒绝并说清原因**，
 *   人工确认后带 `force=1` 才放行；
 * - 两个数都走系统参数（`ai.anomaly.windowDefaultMonths` / `ai.anomaly.windowMaxMonths`）——
 *   财务口径会变，写死等于「谁都不敢调」（同 anomaly-config.ts 的理由）。
 *
 * == 为什么按「自然月」而不是「天数」==
 * 业务对账按月度结算单走，人说「近一年」= 12 个自然月；按天数会在月末/闰年上出现
 * 「选 12 个月却覆盖 13 个月」这种自相矛盾的说法。计数口径**含首尾**：
 * `2026-01-01 ~ 2026-12-31` = 12 个月，`2026-01-20 ~ 2026-02-03` = 2 个月（只看年月差）。
 *
 * 纯函数：不读时钟（`now` 由调用方注入）、不读库、不抛 Nest 异常——`npm test` 可裸跑；
 * 400 的文案也在这里生成，接口报错与面板确认框共用同一份，避免两处措辞漂移。
 */
import { endOfDay, localDayKey, parseLocalDay } from '../../ai-core/common/period.ts';

/** 参数缺省值：默认近 12 个自然月，上限 24 个自然月 */
export const ANOMALY_WINDOW_DEFAULTS = { defaultMonths: 12, maxMonths: 24 } as const;

/**
 * 系统参数的夹逼边界。
 * 下限 1：填 0 会把区间压成空窗口（谁也别想看数据）；上限 120：再大就不是「预警」而是全库扫描。
 */
export const ANOMALY_WINDOW_BOUNDS = { minMonths: 1, maxMonthsUpper: 120 } as const;

export interface AnomalyWindowLimits {
  /** 调用方不给区间时的默认跨度（自然月） */
  defaultMonths: number;
  /** 上限（自然月）：超过要先人工确认 */
  maxMonths: number;
}

export interface AnomalyWindowQuery {
  from?: string | null;
  to?: string | null;
  /** 调用方已人工确认「超过上限也照扫」 */
  force?: boolean;
}

export interface ResolvedAnomalyWindow {
  /** 已解析的区间（含首日零点 / 末日末刻，与取数 where 同口径） */
  from: Date;
  to: Date;
  /** 本地日键 `YYYY-MM-DD`（响应/日志里给的是这个，不带时区歧义） */
  fromDay: string;
  toDay: string;
  /** 覆盖的自然月数（含首尾） */
  months: number;
  /** 区间是系统按默认跨度给出的（调用方既没给 from 也没给 to） */
  defaulted: boolean;
  /** 超过上限 —— 是否放行由调用方决定（service：`overLimit && !forced` 就 400） */
  overLimit: boolean;
  /** 超过上限但调用方已确认 */
  forced: boolean;
  defaultMonths: number;
  maxMonths: number;
}

/** 硬错误（参数本身不合法）：这三种无论 force 都不能放行 */
export type AnomalyWindowRejectReason = 'invalidFrom' | 'invalidTo' | 'reversed';

export type AnomalyWindowOutcome =
  | { ok: true; window: ResolvedAnomalyWindow }
  | { ok: false; reason: AnomalyWindowRejectReason; message: string; maxMonths: number };

/**
 * 自然月计数（**含首尾**）：只看年月差，不看具体日。
 * 「1 月 20 日 ~ 2 月 3 日」= 2 个月——跨了两个月就要按两个月算，否则「近 12 个月」会在月末缩水成 11。
 */
export function countWindowMonths(from: Date, to: Date): number {
  return to.getFullYear() * 12 + to.getMonth() - (from.getFullYear() * 12 + from.getMonth()) + 1;
}

/** 缺起点时的兜底：以锚点所在月为**末月**，往前数 `months` 个自然月的首日零点 */
export function defaultWindowStart(anchor: Date, months: number): Date {
  return new Date(anchor.getFullYear(), anchor.getMonth() - (months - 1), 1, 0, 0, 0, 0);
}

/**
 * 超上限提示（扫描接口的 400 与面板的确认框共用一份文案）。
 * 三件事必须说全：**超了多少**、**上限是多少**、**怎么继续**——只写「区间过大」会让人反复试。
 */
export function overLimitMessage(months: number, maxMonths: number): string {
  return (
    `所选区间覆盖 ${months} 个自然月，超过预警取数上限 ${maxMonths} 个月。` +
    `请缩小到 ${maxMonths} 个月以内；若确实要看整个项目周期，请先确认（接口参数 force=1）再扫描。`
  );
}

function clampMonths(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return Math.min(ANOMALY_WINDOW_BOUNDS.maxMonthsUpper, Math.max(ANOMALY_WINDOW_BOUNDS.minMonths, rounded));
}

/**
 * 参数补齐 + 夹逼（配置解析与直接调用者共用）。
 * 上限小于默认值等于「默认一开就超限」，那套配置没有可执行语义 → 抬到默认值。
 */
export function resolveWindowLimits(partial?: Partial<AnomalyWindowLimits>): AnomalyWindowLimits {
  const defaultMonths = clampMonths(partial?.defaultMonths, ANOMALY_WINDOW_DEFAULTS.defaultMonths);
  const maxMonths = clampMonths(partial?.maxMonths, ANOMALY_WINDOW_DEFAULTS.maxMonths);
  return { defaultMonths, maxMonths: Math.max(defaultMonths, maxMonths) };
}

/**
 * 解析取数区间。
 *
 * 缺省规则（**部分缺省也有意义**：面板只改一端时不该把另一端当「不限」）：
 * - 都不给 → 默认跨度（近 N 个自然月，末端到今天收尾）；
 * - 只给 `to` → 起点按默认跨度以 `to` 为锚回推；
 * - 只给 `from` → 终点取今天收尾（「从某天到现在」是人的直觉）。
 *
 * ⚠️ 日期必须是 `YYYY-MM-DD`（`parseLocalDay` 按**本地零点**解析）。原来这里用 `new Date(str)`，
 * 而 `new Date("2026-01-01")` 按 UTC 解析 → 容器 TZ=Asia/Shanghai 下首日 00:00–08:00 的单据静默漏判。
 */
export function resolveAnomalyWindow(
  input: AnomalyWindowQuery,
  now: Date,
  limits?: Partial<AnomalyWindowLimits>,
): AnomalyWindowOutcome {
  const lim = resolveWindowLimits(limits);
  const rawFrom = String(input?.from ?? '').trim();
  const rawTo = String(input?.to ?? '').trim();

  const fromInput = rawFrom ? parseLocalDay(rawFrom) : null;
  if (rawFrom && !fromInput) {
    return {
      ok: false, reason: 'invalidFrom',
      message: `起始日期不合法（需 YYYY-MM-DD）：${rawFrom}`,
      maxMonths: lim.maxMonths,
    };
  }
  const toInput = rawTo ? parseLocalDay(rawTo) : null;
  if (rawTo && !toInput) {
    return {
      ok: false, reason: 'invalidTo',
      message: `结束日期不合法（需 YYYY-MM-DD）：${rawTo}`,
      maxMonths: lim.maxMonths,
    };
  }

  const defaulted = !fromInput && !toInput;
  const anchor = toInput ?? now;
  const to = endOfDay(anchor);
  const from = fromInput ?? defaultWindowStart(anchor, lim.defaultMonths);
  if (from.getTime() > to.getTime()) {
    return {
      ok: false, reason: 'reversed',
      message: `起始日期不能晚于结束日期：${localDayKey(from)} > ${localDayKey(to)}`,
      maxMonths: lim.maxMonths,
    };
  }

  const months = countWindowMonths(from, to);
  const overLimit = months > lim.maxMonths;
  return {
    ok: true,
    window: {
      from,
      to,
      fromDay: localDayKey(from),
      toDay: localDayKey(to),
      months,
      defaulted,
      overLimit,
      forced: overLimit && input?.force === true,
      defaultMonths: lim.defaultMonths,
      maxMonths: lim.maxMonths,
    },
  };
}
