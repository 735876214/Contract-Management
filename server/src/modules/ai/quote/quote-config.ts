/**
 * 课题 3-9 · **阈值配置层**（`SysParam` 的 `ai.quote.*`）。
 *
 * 与 6-9 的 `anomaly-config.ts` 同构：一条参数写错不该让接口 500，
 * 而是回落默认值 + 在 `problems` 里留一句人话，面板会把这些话展示给管理员。
 */

import { type Cents, moneyToCents } from '../common/money.ts';
import { clamp, parseBoolFlag, parseDecimal, parseInteger } from '../common/params.ts';
import { DEFAULT_QUOTE_TOLERANCES, type QuoteTolerances } from './quote-types.ts';

/** 参数键（全部挂 `ai.quote.` 前缀，便于与 6-9 的 `ai.anomaly.*` 区分） */
export const QUOTE_PARAM_KEYS = {
  enabled: 'ai.quote.enabled',
  narrative: 'ai.quote.narrative',
  amountTolerance: 'ai.quote.amountTolerance',
  dropPct: 'ai.quote.dropPct',
  spreadPct: 'ai.quote.spreadPct',
  underBudgetPct: 'ai.quote.underBudgetPct',
  priceDevPct: 'ai.quote.priceDevPct',
  taxRateToleranceBp: 'ai.quote.taxRateToleranceBp',
  minBidders: 'ai.quote.minBidders',
} as const;

/** 一次查询的键清单（service 用它批量 `sysParam.get`，避免 N 次来回） */
export const QUOTE_PARAM_KEY_LIST = Object.values(QUOTE_PARAM_KEYS);

/** 默认值（写进 SysParam 管理界面时可直接抄） */
export const QUOTE_PARAM_DEFAULTS: Record<string, string> = {
  [QUOTE_PARAM_KEYS.enabled]: '1',
  [QUOTE_PARAM_KEYS.narrative]: '1',
  [QUOTE_PARAM_KEYS.amountTolerance]: '1',
  [QUOTE_PARAM_KEYS.dropPct]: '20',
  [QUOTE_PARAM_KEYS.spreadPct]: '3',
  [QUOTE_PARAM_KEYS.underBudgetPct]: '70',
  [QUOTE_PARAM_KEYS.priceDevPct]: '15',
  [QUOTE_PARAM_KEYS.taxRateToleranceBp]: '30',
  [QUOTE_PARAM_KEYS.minBidders]: '3',
};

export interface QuoteConfig {
  /** 总开关：关闭时接口只回 `enabled:false`，不查库不算 */
  enabled: boolean;
  /** 是否调用模型润色（关闭时用模板结论，行为完全确定） */
  narrative: boolean;
  tolerances: QuoteTolerances;
  /** 参数问题（人话，面板原样展示） */
  problems: string[];
}

/**
 * 解析一组原始参数。键缺失 → 用默认值（**不报 problem**，这是正常状态）；
 * 键存在但值非法 → 用默认值并记 problem。
 */
export function parseQuoteConfig(raw: Record<string, string | null | undefined>): QuoteConfig {
  const problems: string[] = [];
  const flag = (key: string, def: boolean): boolean => {
    const v = parseBoolFlag(raw[key]);
    if (v !== null) return v;
    if (raw[key] != null && String(raw[key]).trim() !== '') {
      problems.push(`${key} 的值“${raw[key]}”无法识别，按默认“${def ? '开启' : '关闭'}”处理`);
    }
    return def;
  };

  const number = (key: string, def: number, min: number, max: number, unit = ''): number => {
    const v = parseDecimal(raw[key]);
    if (v === null) {
      if (raw[key] != null && String(raw[key]).trim() !== '') {
        problems.push(`${key} 的值“${raw[key]}”不是数字，按默认 ${def}${unit} 处理`);
      }
      return def;
    }
    const clamped = clamp(v, min, max);
    if (clamped !== v) {
      problems.push(`${key} 的 ${v}${unit} 超出可设范围，按 ${clamped}${unit} 处理`);
    }
    return clamped;
  };

  const integer = (key: string, def: number, min: number, max: number, unit = ''): number => {
    const v = parseInteger(raw[key]);
    if (v === null) {
      if (raw[key] != null && String(raw[key]).trim() !== '') {
        problems.push(`${key} 的值“${raw[key]}”不是整数，按默认 ${def}${unit} 处理`);
      }
      return def;
    }
    const clamped = Math.round(clamp(v, min, max));
    if (clamped !== v) problems.push(`${key} 的 ${v}${unit} 超出可设范围，按 ${clamped}${unit} 处理`);
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

  return {
    enabled: flag(QUOTE_PARAM_KEYS.enabled, true),
    narrative: flag(QUOTE_PARAM_KEYS.narrative, true),
    tolerances: {
      amount: amount(QUOTE_PARAM_KEYS.amountTolerance, DEFAULT_QUOTE_TOLERANCES.amount),
      dropPct: number(QUOTE_PARAM_KEYS.dropPct, DEFAULT_QUOTE_TOLERANCES.dropPct, 0, 100, '%'),
      spreadPct: number(QUOTE_PARAM_KEYS.spreadPct, DEFAULT_QUOTE_TOLERANCES.spreadPct, 0, 100, '%'),
      underBudgetPct: number(QUOTE_PARAM_KEYS.underBudgetPct, DEFAULT_QUOTE_TOLERANCES.underBudgetPct, 0, 100, '%'),
      priceDevPct: number(QUOTE_PARAM_KEYS.priceDevPct, DEFAULT_QUOTE_TOLERANCES.priceDevPct, 0, 100, '%'),
      taxRateToleranceBp: integer(
        QUOTE_PARAM_KEYS.taxRateToleranceBp,
        DEFAULT_QUOTE_TOLERANCES.taxRateToleranceBp,
        0,
        5000,
        ' 基点',
      ),
      minBidders: integer(QUOTE_PARAM_KEYS.minBidders, DEFAULT_QUOTE_TOLERANCES.minBidders, 1, 20, ' 家'),
    },
    problems,
  };
}

/** 阈值的中文描述（面板与提示词共用同一句，避免两处措辞不一致） */
export function quoteToleranceText(tol: QuoteTolerances): string {
  return [
    `金额容差 ${(Number(tol.amount) / 100).toFixed(2)} 元`,
    `二轮降幅 > ${tol.dropPct}%`,
    `首轮离散系数 < ${tol.spreadPct}%`,
    `成交价 < 控制价 ${tol.underBudgetPct}%`,
    `单价偏离市场价 ±${tol.priceDevPct}%`,
    `税率差 > ${(tol.taxRateToleranceBp / 100).toFixed(2)} 个百分点`,
    `有效报价 < ${tol.minBidders} 家`,
  ].join('；');
}
