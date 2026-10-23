/**
 * 课题 7-11 · **阈值配置层**（`SysParam` 的 `ai.analysis.*`）。
 *
 * 与 `anomaly-config.ts`（6-9）、`quote-config.ts`（3-9）、`fulfillment-config.ts`（4-9）同构：
 * 一条参数写错不该让接口 500，而是回落默认值 + 在 `problems` 里留一句人话。
 *
 * 本课题的阈值都是**比例与名次**（集中度警戒线、开票缺口、榜单条数），
 * 没有金额容差——全景报告不做逐笔金额比对，金额只出现在汇总事实里。
 */

import { clamp, parseBoolFlag, parseDecimal, parseInteger } from '../common/params.ts';
import { DEFAULT_SCM_TOLERANCES, type ScmTolerances } from './scm-types.ts';

/** 参数键（`ai.analysis.` 前缀，与前三个课题区分） */
export const SCM_PARAM_KEYS = {
  enabled: 'ai.analysis.enabled',
  narrative: 'ai.analysis.narrative',
  topSharePct: 'ai.analysis.topSharePct',
  invoiceGapPct: 'ai.analysis.invoiceGapPct',
  topSuppliers: 'ai.analysis.topSuppliers',
} as const;

/** 一次请求的键清单（service 批量 `sysParam.get`，避免 N 次来回） */
export const SCM_PARAM_KEY_LIST = Object.values(SCM_PARAM_KEYS);

/** 默认值（可直接抄进 SysParam 管理界面） */
export const SCM_PARAM_DEFAULTS: Record<string, string> = {
  [SCM_PARAM_KEYS.enabled]: '1',
  [SCM_PARAM_KEYS.narrative]: '1',
  [SCM_PARAM_KEYS.topSharePct]: '50',
  [SCM_PARAM_KEYS.invoiceGapPct]: '20',
  [SCM_PARAM_KEYS.topSuppliers]: '5',
};

export interface ScmConfig {
  /** 总开关：关闭时接口只回 `enabled:false`，不查库不算 */
  enabled: boolean;
  /** 是否调用模型撰写（关闭时用确定性汇总，行为完全可复现） */
  narrative: boolean;
  tolerances: ScmTolerances;
  /** 参数问题（人话，面板原样展示） */
  problems: string[];
}

/**
 * 解析一组原始参数。键缺失 → 默认值（不报 problem，这是正常状态）；
 * 键存在但值非法 → 默认值 + 一条 problem。
 */
export function parseScmConfig(raw: Record<string, string | null | undefined>): ScmConfig {
  const problems: string[] = [];

  const flag = (key: string, def: boolean): boolean => {
    const v = parseBoolFlag(raw[key]);
    if (v !== null) return v;
    if (raw[key] != null && String(raw[key]).trim() !== '') {
      problems.push(`${key} 的值“${raw[key]}”无法识别，按默认“${def ? '开启' : '关闭'}”处理`);
    }
    return def;
  };

  const pct = (key: string, def: number): number => {
    const v = parseDecimal(raw[key]);
    if (v === null) {
      if (raw[key] != null && String(raw[key]).trim() !== '') {
        problems.push(`${key} 的值“${raw[key]}”不是数字，按默认 ${def}% 处理`);
      }
      return def;
    }
    const clamped = Math.round(clamp(v, 0, 100) * 10) / 10;
    if (clamped !== v) problems.push(`${key} 的 ${v}% 超出 0–100 范围，按 ${clamped}% 处理`);
    return clamped;
  };

  const count = (key: string, def: number): number => {
    const v = parseInteger(raw[key]);
    if (v === null) {
      if (raw[key] != null && String(raw[key]).trim() !== '') {
        problems.push(`${key} 的值“${raw[key]}”不是整数，按默认 ${def} 处理`);
      }
      return def;
    }
    const clamped = Math.round(clamp(v, 1, 20));
    if (clamped !== v) problems.push(`${key} 的 ${v} 超出 1–20 范围，按 ${clamped} 处理`);
    return clamped;
  };

  const d = DEFAULT_SCM_TOLERANCES;
  return {
    enabled: flag(SCM_PARAM_KEYS.enabled, true),
    narrative: flag(SCM_PARAM_KEYS.narrative, true),
    tolerances: {
      topSharePct: pct(SCM_PARAM_KEYS.topSharePct, d.topSharePct),
      invoiceGapPct: pct(SCM_PARAM_KEYS.invoiceGapPct, d.invoiceGapPct),
      topSuppliers: count(SCM_PARAM_KEYS.topSuppliers, d.topSuppliers),
    },
    problems,
  };
}

/** 阈值中文描述（面板与提示词共用同一句，避免两处措辞不一致） */
export function scmToleranceText(tol: ScmTolerances): string {
  return [
    `供应商集中度警戒线 ${tol.topSharePct}%`,
    `开票缺口警戒线 ${tol.invoiceGapPct} 个百分点`,
    `供应商榜取前 ${tol.topSuppliers} 名`,
  ].join('；');
}

/** 供面板/文档直读的默认值列表（与 `SysParam` 管理界面字段一一对应） */
export function scmParamHints(): Array<{ key: string; def: string; note: string }> {
  return [
    { key: SCM_PARAM_KEYS.enabled, def: '1', note: '总开关，0 关闭后接口只回 enabled:false' },
    { key: SCM_PARAM_KEYS.narrative, def: '1', note: '0 = 不调模型，只出确定性汇总' },
    { key: SCM_PARAM_KEYS.topSharePct, def: '50', note: '单一供应商签约额占比超过多少个百分点算过度集中' },
    { key: SCM_PARAM_KEYS.invoiceGapPct, def: '20', note: '开票落后结算多少个百分点算票款脱节' },
    { key: SCM_PARAM_KEYS.topSuppliers, def: '5', note: '供应商集中度榜取前几名（1–20）' },
  ];
}
