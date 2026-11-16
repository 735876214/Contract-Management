/**
 * 课题 4-9 · **阈值配置层**（`SysParam` 的 `ai.fulfillment.*`）。
 *
 * 与 `anomaly-config.ts`（6-9）、`quote-config.ts`（3-9）同构：
 * 一条参数写错不该让接口 500，而是回落默认值 + 在 `problems` 里留一句人话。
 *
 * **本课题的阈值都是「天数」或「百分点」，没有金额阈值**——
 * 履约偏差判定里唯一的金额用途是付款比例的分母，不做金额容差比较，
 * 所以 `amount` 只作为「金额 ≥ 0 的兜底」保留在容差结构里（口径与规则层一致）。
 */

import { type Cents, moneyToCents } from '../common/money.ts';
import { clamp, parseBoolFlag, parseDecimal, parseInteger } from '../common/params.ts';
import { DEFAULT_FULFILLMENT_TOLERANCES, type FulfillmentTolerances } from './fulfillment-types.ts';

/** 参数键（`ai.fulfillment.` 前缀，与 6-9 `ai.anomaly.*`、3-9 `ai.quote.*` 区分） */
export const FULFILLMENT_PARAM_KEYS = {
  enabled: 'ai.fulfillment.enabled',
  narrative: 'ai.fulfillment.narrative',
  graceDays: 'ai.fulfillment.graceDays',
  lateFinishDays: 'ai.fulfillment.lateFinishDays',
  progressGapPct: 'ai.fulfillment.progressGapPct',
  amountTolerance: 'ai.fulfillment.amountTolerance',
} as const;

/** 一次查询的键清单（service 用它批量 `sysParam.get`，避免 N 次来回） */
export const FULFILLMENT_PARAM_KEY_LIST = Object.values(FULFILLMENT_PARAM_KEYS);

/** 默认值（可直接抄进 SysParam 管理界面） */
export const FULFILLMENT_PARAM_DEFAULTS: Record<string, string> = {
  [FULFILLMENT_PARAM_KEYS.enabled]: '1',
  [FULFILLMENT_PARAM_KEYS.narrative]: '1',
  [FULFILLMENT_PARAM_KEYS.graceDays]: '7',
  [FULFILLMENT_PARAM_KEYS.lateFinishDays]: '7',
  [FULFILLMENT_PARAM_KEYS.progressGapPct]: '30',
  [FULFILLMENT_PARAM_KEYS.amountTolerance]: '1',
};

export interface FulfillmentConfig {
  /** 总开关：关闭时接口只回 `enabled:false`，不查库不算 */
  enabled: boolean;
  /** 是否调用模型润色（关闭时用模板结论，行为完全确定） */
  narrative: boolean;
  tolerances: FulfillmentTolerances;
  /** 参数问题（人话，面板原样展示） */
  problems: string[];
}

/**
 * 解析一组原始参数。键缺失 → 默认值（不报 problem，这是正常状态）；
 * 键存在但值非法 → 默认值 + 一条 problem。
 */
export function parseFulfillmentConfig(raw: Record<string, string | null | undefined>): FulfillmentConfig {
  const problems: string[] = [];

  const flag = (key: string, def: boolean): boolean => {
    const v = parseBoolFlag(raw[key]);
    if (v !== null) return v;
    if (raw[key] != null && String(raw[key]).trim() !== '') {
      problems.push(`${key} 的值“${raw[key]}”无法识别，按默认“${def ? '开启' : '关闭'}”处理`);
    }
    return def;
  };

  const integer = (key: string, def: number, min: number, max: number, unit = ''): number => {
    const v = parseInteger(raw[key]);
    if (v === null) {
      if (raw[key] != null && String(raw[key]).trim() !== '') {
        problems.push(`${key} 的值“${raw[key]}”不是整数，按默认 ${def}${unit}处理`);
      }
      return def;
    }
    const clamped = Math.round(clamp(v, min, max));
    if (clamped !== v) problems.push(`${key} 的 ${v}${unit}超出可设范围，按 ${clamped}${unit}处理`);
    return clamped;
  };

  const amount = (key: string, def: Cents): Cents => {
    const raw0 = raw[key];
    if (raw0 == null || String(raw0).trim() === '') return def;
    const cents = moneyToCents(raw0);
    if (cents === null || cents < 0n) {
      problems.push(`${key} 的值“${raw0}”不是合法金额，按默认 1.00 元处理`);
      return def;
    }
    return cents;
  };

  // 天数上限 365 天：填 10000 天等于把规则关掉，不如拦住并提示
  const d = DEFAULT_FULFILLMENT_TOLERANCES;

  return {
    enabled: flag(FULFILLMENT_PARAM_KEYS.enabled, true),
    narrative: flag(FULFILLMENT_PARAM_KEYS.narrative, true),
    tolerances: {
      amount: amount(FULFILLMENT_PARAM_KEYS.amountTolerance, d.amount),
      graceDays: integer(FULFILLMENT_PARAM_KEYS.graceDays, d.graceDays, 0, 365, ' 天'),
      lateFinishDays: integer(FULFILLMENT_PARAM_KEYS.lateFinishDays, d.lateFinishDays, 0, 365, ' 天'),
      progressGapPct: integer(FULFILLMENT_PARAM_KEYS.progressGapPct, d.progressGapPct, 0, 100, ' 个百分点'),
    },
    problems,
  };
}

/** 阈值的中文描述（面板与提示词共用同一句，避免两处措辞不一致） */
export function fulfillmentToleranceText(tol: FulfillmentTolerances): string {
  return [
    `逾期宽限 ${tol.graceDays} 天`,
    `逾期 > 30 天升级高风险`,
    `完成滞后容忍 ${tol.lateFinishDays} 天`,
    `付款比例高于完成率 > ${tol.progressGapPct} 个百分点`,
  ].join('；');
}

/** 供面板直读的默认值列表（与 `SysParam` 管理界面字段一一对应） */
export function fulfillmentParamHints(): Array<{ key: string; def: string; note: string }> {
  return [
    { key: FULFILLMENT_PARAM_KEYS.enabled, def: '1', note: '总开关，0 关闭后接口只回 enabled:false' },
    { key: FULFILLMENT_PARAM_KEYS.narrative, def: '1', note: '0 = 不调模型，用模板结论' },
    { key: FULFILLMENT_PARAM_KEYS.graceDays, def: '7', note: '节点逾期宽限天数（计划日期过后多少天才报）' },
    { key: FULFILLMENT_PARAM_KEYS.lateFinishDays, def: '7', note: '实际完成比计划晚超过多少天才报' },
    { key: FULFILLMENT_PARAM_KEYS.progressGapPct, def: '30', note: '付款比例高于节点完成率多少个百分点才报' },
    { key: FULFILLMENT_PARAM_KEYS.amountTolerance, def: '1', note: '金额兜底容差（元），本课题仅用于分母保护' },
  ];
}

/** 兼容：面板/测试若只想拿数字阈值，可直接用这个（避免重复 parseInt 逻辑） */
export function parseFulfillmentToleranceRaw(raw: unknown): number | null {
  return parseDecimal(raw);
}
