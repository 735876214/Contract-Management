import { type AnomalyTolerances, moneyToCents, resolveTolerances } from './anomaly-types.ts';
import { parseBoolFlag, parseDecimal, parseInteger } from '../common/params.ts';
import { ANOMALY_WINDOW_DEFAULTS, resolveWindowLimits, type AnomalyWindowLimits } from './anomaly-window.ts';

/**
 * 异常预警的**阈值与开关**：全部走系统参数（`SysParam`），改完点「刷新缓存」即生效，不用发版。
 *
 * 为什么不写死在代码里（产品决策 D3）：金额容差、数量容差、明细重合度这三个数
 * 是**业务口径**而不是技术常量——财务换了口径、或者某项目计量单位特殊，就得能调。
 * 写死会逼出一个「代码改一个数 → 走一遍发版」的流程，实际结果是谁都不敢调。
 *
 * 参数键统一前缀 `ai.anomaly.`，与 AI 信息登记的 `ai.*` 同族，便于运维按前缀备份。
 * 键缺省时取这里的默认值；**值非法时不静默吞掉**，而是回落默认值并在 `problems` 里留痕，
 * 由 service 写进响应的 `warnings`，避免「调错了但系统假装没事」。
 */
export const ANOMALY_PARAM_KEYS = {
  /** '1'/'0'：总开关（关掉后接口返回 enabled:false，不报错） */
  enabled: 'ai.anomaly.enabled',
  /** '1'/'0'：是否让模型写总体结论（关掉＝只用模板串，不消耗额度） */
  narrative: 'ai.anomaly.narrative',
  /** 金额容差（元，两位小数）：差额 ≤ 此值视为一致 */
  amountTolerance: 'ai.anomaly.amountTolerance',
  /** 数量容差（百分点，整数或小数）：合同清单量允许超出的百分比 */
  qtyTolerancePct: 'ai.anomaly.qtyTolerancePct',
  /** 明细重合度（0..1）：低于此值不算「同一批明细」 */
  jaccard: 'ai.anomaly.jaccard',
  /** 取数期间默认跨度（自然月）：调用方不给 from/to 时用，默认 12 */
  windowDefaultMonths: 'ai.anomaly.windowDefaultMonths',
  /** 取数期间上限（自然月）：超过要先人工确认（force=1），默认 24 */
  windowMaxMonths: 'ai.anomaly.windowMaxMonths',
} as const;

/** 参数键的默认值（`SysParam` 里没有该键时使用） */
export const ANOMALY_PARAM_DEFAULTS: Record<string, string> = {
  [ANOMALY_PARAM_KEYS.enabled]: '1',
  [ANOMALY_PARAM_KEYS.narrative]: '1',
  [ANOMALY_PARAM_KEYS.amountTolerance]: '1.00',
  [ANOMALY_PARAM_KEYS.qtyTolerancePct]: '2',
  [ANOMALY_PARAM_KEYS.jaccard]: '0.8',
  [ANOMALY_PARAM_KEYS.windowDefaultMonths]: String(ANOMALY_WINDOW_DEFAULTS.defaultMonths),
  [ANOMALY_PARAM_KEYS.windowMaxMonths]: String(ANOMALY_WINDOW_DEFAULTS.maxMonths),
};

export interface AnomalyConfig {
  enabled: boolean;
  narrative: boolean;
  tolerances: AnomalyTolerances;
  /** 取数期间的默认跨度与上限（自然月），口径见 anomaly-window.ts */
  window: AnomalyWindowLimits;
  /** 值非法被回落的项（形如 `ai.anomaly.jaccard=abc，已回落 0.8`），进响应 warnings */
  problems: string[];
}

/**
 * 开关：认得 `1/true/on/yes/y` 与 `0/false/off/no/n`；其它值 → 回落默认值 + 留痕。
 * 解析原语与其它预警阈值共用 `ai/common/params.ts`，本文件不再自己写一份（两处各写必然漂移）。
 */
function parseFlag(raw: string | undefined, key: string, def: boolean, problems: string[]): boolean {
  if (raw == null || raw === '') return def;
  const v = parseBoolFlag(raw);
  if (v === null) {
    problems.push(`${key}=${raw}，已回落 ${def ? '1' : '0'}`);
    return def;
  }
  return v;
}

/** 十进制数（容忍千分位与尾部 %）；非法 → 回落默认值 + 留痕 */
function parseNumber(raw: string | undefined, key: string, def: number, problems: string[]): number {
  if (raw == null || raw === '') return def;
  const n = parseDecimal(raw);
  if (n === null) {
    problems.push(`${key}=${raw}，已回落 ${def}`);
    return def;
  }
  return n;
}

/**
 * 把「参数键 → 原始字符串」解析成配置。
 *
 * **纯函数**（不读库、不读环境变量）：这样单测能锁住「非法值回落」「开关语义」，
 * 而读库那一层只是 `SysParamService.get` 的机械拼装，出错的概率远低于解析规则。
 */
export function parseAnomalyConfig(raw: Record<string, string | undefined>): AnomalyConfig {
  const problems: string[] = [];
  const enabled = parseFlag(raw[ANOMALY_PARAM_KEYS.enabled], ANOMALY_PARAM_KEYS.enabled, true, problems);
  const narrative = parseFlag(raw[ANOMALY_PARAM_KEYS.narrative], ANOMALY_PARAM_KEYS.narrative, true, problems);

  // 金额容差：元 → 分。允许 '1'、'1.00'、'0'（0 表示分位必须严格相等）
  const amountRaw = raw[ANOMALY_PARAM_KEYS.amountTolerance];
  let amount = resolveTolerances().amount;
  if (amountRaw != null && amountRaw !== '') {
    const cents = moneyToCents(String(amountRaw).trim());
    if (cents == null || cents < 0n) {
      problems.push(`${ANOMALY_PARAM_KEYS.amountTolerance}=${amountRaw}，已回落 1.00`);
    } else {
      amount = cents;
    }
  }

  const qtyRaw = parseNumber(raw[ANOMALY_PARAM_KEYS.qtyTolerancePct], ANOMALY_PARAM_KEYS.qtyTolerancePct, 2, problems);
  // 数量容差超过 100% 等于「不设上限」，那是把规则关掉，必须显式用开关而不是靠一个诡异的数
  const qtyPct = qtyRaw < 0 ? 0 : qtyRaw > 100 ? 100 : qtyRaw;
  if (qtyRaw !== qtyPct) problems.push(`${ANOMALY_PARAM_KEYS.qtyTolerancePct}=${qtyRaw}，已夹到 ${qtyPct}`);

  const jRaw = parseNumber(raw[ANOMALY_PARAM_KEYS.jaccard], ANOMALY_PARAM_KEYS.jaccard, 0.8, problems);
  // Jaccard 定义域 0..1；越界一律夹紧（0 = 只要有交集就算同一批，1 = 必须完全一致）
  const jaccard = jRaw < 0 ? 0 : jRaw > 1 ? 1 : jRaw;
  if (jRaw !== jaccard) problems.push(`${ANOMALY_PARAM_KEYS.jaccard}=${jRaw}，已夹到 ${jaccard}`);

  /**
   * 取数期间的默认跨度与上限（自然月）：值非法 → 回落默认 + 留痕，再由 `resolveWindowLimits` 夹逼。
   * 「上限 < 默认」会被抬到默认值——否则默认一开就超限，那套配置没有可执行语义。
   */
  const defRaw = raw[ANOMALY_PARAM_KEYS.windowDefaultMonths];
  const maxRaw = raw[ANOMALY_PARAM_KEYS.windowMaxMonths];
  const windowDefaultMonths = parseInteger(defRaw);
  const windowMaxMonths = parseInteger(maxRaw);
  if (defRaw != null && defRaw !== '' && windowDefaultMonths === null) {
    problems.push(`${ANOMALY_PARAM_KEYS.windowDefaultMonths}=${defRaw}，已回落 ${ANOMALY_WINDOW_DEFAULTS.defaultMonths}`);
  }
  if (maxRaw != null && maxRaw !== '' && windowMaxMonths === null) {
    problems.push(`${ANOMALY_PARAM_KEYS.windowMaxMonths}=${maxRaw}，已回落 ${ANOMALY_WINDOW_DEFAULTS.maxMonths}`);
  }
  const window = resolveWindowLimits({
    defaultMonths: windowDefaultMonths ?? ANOMALY_WINDOW_DEFAULTS.defaultMonths,
    maxMonths: windowMaxMonths ?? ANOMALY_WINDOW_DEFAULTS.maxMonths,
  });
  // 越界夹紧与自洽修正也要说出来：静默改数是调参最怕的事（调了没生效，人只会反复调）
  if (windowDefaultMonths !== null && windowDefaultMonths !== window.defaultMonths) {
    problems.push(`${ANOMALY_PARAM_KEYS.windowDefaultMonths}=${windowDefaultMonths}，已夹到 ${window.defaultMonths}`);
  }
  if (windowMaxMonths !== null && windowMaxMonths !== window.maxMonths) {
    problems.push(`${ANOMALY_PARAM_KEYS.windowMaxMonths}=${windowMaxMonths}，已夹到 ${window.maxMonths}`);
  }

  return { enabled, narrative, tolerances: resolveTolerances({ amount, qtyPct, jaccard }), window, problems };
}

/** 需要 `SysParamService.get` 的键（service 按这个列表取，避免漏键静默走默认值） */
export const ANOMALY_PARAM_KEY_LIST: string[] = Object.values(ANOMALY_PARAM_KEYS);
