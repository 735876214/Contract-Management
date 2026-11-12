/**
 * AI 经营数据助手 · **规则意图解析（纯函数，无模型兜底）**。
 *
 * 用途：AI 未配置 / 调用失败 / 模型返回坏 JSON 时的确定性兜底；Phase 1 的 `POST /plan` 只走这条路径。
 *
 * 硬约束（2026-11-12 评审）：
 * - 只输出枚举与注册表 key；**不产出 ID / 日期 / 金额**；
 * - 前端结构化选择**逐字段覆盖**文本解析：`datasets` 非空时整体替换（不做并集），
 *   其余显式字段覆盖同名项；
 * - 未知 dataset / focus 一律丢弃并进 `warnings`，不静默选错。
 */

import {
  AI_COMPARE_MODES,
  AI_DETAIL_LEVELS,
  AI_FOCUSES,
  AI_GROUP_BYS,
  AI_PERIOD_PRESETS,
  AI_REPORT_KINDS,
  AI_SCOPE_MODES,
  type AiAnalyticsIntent,
  type AiCompareMode,
  type AiDetailLevel,
  type AiFocus,
  type AiGroupBy,
  type AiPeriodPreset,
  type AiReportKind,
  type AiScopeMode,
} from '../analytics/analytics.types.ts';
import { datasetByKey, DEFAULT_DATASET_KEYS, limitDatasets, MAX_DATASETS } from '../analytics/dataset-registry.ts';
import type { AiAnalyticsPlanInput, RulesParseResult } from './intent.types.ts';

/** 关键词 → 数据集 key（**长词在前**，泛词放后；匹配到即选中） */
const DATASET_KEYWORDS: ReadonlyArray<{ key: string; words: string[] }> = [
  { key: 'final_settlement.summary', words: ['工作总结算', '总结算'] },
  { key: 'settlement.ledger', words: ['结算台账'] },
  { key: 'settlement.detail', words: ['结算单清单', '结算明细', '结算单'] },
  { key: 'settlement.summary', words: ['结算汇总', '结算情况', '结算'] },
  { key: 'contract.change_log', words: ['合同变更', '变更日志'] },
  { key: 'contract.fulfillment', words: ['履约进度', '履约'] },
  { key: 'contract.detail', words: ['合同清单', '合同明细'] },
  { key: 'contract.summary', words: ['合同汇总', '合同情况', '合同'] },
  { key: 'payment_procedure.records', words: ['付款手续'] },
  { key: 'payment.records', words: ['付款'] },
  { key: 'invoice.records', words: ['发票', '开票'] },
  { key: 'repayment.agreement', words: ['还款协议', '还款'] },
  { key: 'finance.cost', words: ['保理', '逾期利息', '资金费用'] },
  { key: 'cost.profit_loss', words: ['盈亏', '利润', '成本分析'] },
  { key: 'cost.labor_receiving', words: ['领用汇总', '分包领用'] },
  { key: 'labor.auth', words: ['分包授权', '授权台账'] },
  { key: 'labor.receiving_doc', words: ['领用单据', '领用单'] },
  { key: 'procurement.documents', words: ['采购公告', '采购文件', '价格对比', '采前会', '考察报告', '评标'] },
  { key: 'procurement.result', words: ['成交', '报价', '定标'] },
  { key: 'procurement.task', words: ['采购任务', '采购'] },
  { key: 'daily.report', words: ['总日报', '日报'] },
  { key: 'receipt.order', words: ['收领单', '到货'] },
  { key: 'asset.flow', words: ['资产进出场', '进出场', '资产'] },
  { key: 'material.base', words: ['物资主数据'] },
  { key: 'material.contract', words: ['合同物资清单', '物资清单'] },
  { key: 'supplier.concentration', words: ['供应商集中', '供应商结构', '供应商'] },
  { key: 'project.base', words: ['项目概况', '项目基本情况'] },
];

const FOCUS_KEYWORDS: ReadonlyArray<{ key: AiFocus; words: string[] }> = [
  { key: 'payment_risk', words: ['付款风险', '欠款', '超付', '资金风险'] },
  { key: 'invoice_gap', words: ['开票落后', '发票缺口', '未开票'] },
  { key: 'cost_overrun', words: ['成本超支', '超支', '亏损'] },
  { key: 'schedule', words: ['进度', '延期', '逾期', '工期'] },
  { key: 'supplier_concentration', words: ['供应商集中', '单点依赖'] },
  { key: 'procurement', words: ['采购风险', '招标风险'] },
  { key: 'asset', words: ['资产风险'] },
];

const hasAny = (text: string, words: readonly string[]): boolean => words.some((w) => text.includes(w));

const pickEnum = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;

/** 文本 → 数据集 keys（按注册表顺序去重后截断） */
function matchDatasets(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const entry of DATASET_KEYWORDS) {
    if (hasAny(text, entry.words) && !out.includes(entry.key)) out.push(entry.key);
  }
  return out;
}

function matchFocus(text: string): AiFocus[] {
  const out: AiFocus[] = [];
  for (const entry of FOCUS_KEYWORDS) {
    if (hasAny(text, entry.words) && !out.includes(entry.key)) out.push(entry.key);
  }
  return out;
}

function parseScope(text: string): AiScopeMode {
  if (/(全部项目|所有项目|全公司|跨项目|各项目|横向对比)/.test(text)) return 'all';
  return 'current';
}

function parsePeriodPreset(text: string): AiPeriodPreset {
  if (/(本月|这个月)/.test(text)) return 'this_month';
  if (/(上月|上个月)/.test(text)) return 'last_month';
  if (/(本季度|这个季度)/.test(text)) return 'this_quarter';
  if (/(近\s*30\s*天|最近\s*30\s*天)/.test(text)) return 'last_30_days';
  if (/(近\s*90\s*天|最近\s*90\s*天)/.test(text)) return 'last_90_days';
  if (/(年初至今|开年至今|年初以来)/.test(text)) return 'ytd';
  if (/(今年|本年|本年度)/.test(text)) return 'this_year';
  if (/(全部|累计至今|历史至今|至今)/.test(text)) return 'all';
  return 'this_month';
}

function parseCompare(text: string): AiCompareMode {
  if (/(同比|去年同期|上年同期|去年)/.test(text)) return 'yoy';
  if (/(环比|上期对比|与上期)/.test(text)) return 'mom';
  return 'mom';
}

function parseReportKind(text: string): AiReportKind {
  if (/(简报|摘要|领导)/.test(text)) return 'brief';
  if (/(月度|月报)/.test(text)) return 'monthly';
  if (/(对比|对照)/.test(text)) return 'comparison';
  if (/(履约|项目汇报)/.test(text)) return 'project';
  return 'custom';
}

function parseDetail(text: string): AiDetailLevel {
  if (/(明细和汇总|汇总和明细|都要|兼顾)/.test(text)) return 'both';
  if (/(明细|清单)/.test(text)) return 'detail';
  if (/(汇总|概览|总览)/.test(text)) return 'summary';
  return 'summary';
}

function parseGroupBy(text: string): AiGroupBy {
  if (/(按月|分月)/.test(text)) return 'month';
  if (/按供应商/.test(text)) return 'supplier';
  if (/按合同/.test(text)) return 'contract';
  return 'project';
}

/**
 * 解析入口。
 *
 * 合并顺序：先按文本得出候选意图 → 再用**显式结构化选择**逐字段覆盖。
 * `datasets` 非空时整体替换（用户点选的数据集优先，不做并集）。
 */
export function parseIntentRules(input: AiAnalyticsPlanInput): RulesParseResult {
  const warnings: string[] = [];
  const unknownDatasets: string[] = [];
  const text = String(input?.text ?? '').slice(0, 2000);
  const notes = input?.notes ? String(input.notes).slice(0, 300) : undefined;

  // ---- 文本解析 ----
  const textScope = parseScope(text);
  const textPeriod = parsePeriodPreset(text);
  let textCompare = parseCompare(text);
  if (textPeriod === 'all') textCompare = 'none';
  const textDatasets = matchDatasets(text);

  // ---- 结构化覆盖：scope ----
  let scopeMode: AiScopeMode = textScope;
  if (input?.scope?.mode != null) {
    const picked = pickEnum(input.scope.mode, AI_SCOPE_MODES);
    if (picked) scopeMode = picked;
    else warnings.push(`忽略未知的范围：${input.scope.mode}`);
  }

  // ---- 结构化覆盖：期间 ----
  let preset: AiPeriodPreset = textPeriod;
  let from = input?.period?.from;
  let to = input?.period?.to;
  if (input?.period?.preset != null) {
    const picked = pickEnum(input.period.preset, AI_PERIOD_PRESETS);
    if (picked) preset = picked;
    else warnings.push(`忽略未知的期间：${input.period.preset}`);
  }
  if (preset === 'custom' && (!from || !to)) {
    warnings.push('自定义期间缺少开始或结束日期，已回落到本月');
    preset = 'this_month';
    from = undefined;
    to = undefined;
  }

  // ---- 结构化覆盖：对比 ----
  let compare: AiCompareMode = textCompare;
  if (input?.compare != null) {
    const picked = pickEnum(input.compare, AI_COMPARE_MODES);
    if (picked) compare = picked;
    else warnings.push(`忽略未知的对比方式：${input.compare}`);
  }
  if (preset === 'all') compare = 'none';

  // ---- 结构化覆盖：报告类型 / 分组 / 明细 ----
  let reportKind: AiReportKind = parseReportKind(text);
  if (input?.reportKind != null) {
    const picked = pickEnum(input.reportKind, AI_REPORT_KINDS);
    if (picked) reportKind = picked;
    else warnings.push(`忽略未知的报告类型：${input.reportKind}`);
  }
  let groupBy: AiGroupBy = parseGroupBy(text);
  if (input?.groupBy != null) {
    const picked = pickEnum(input.groupBy, AI_GROUP_BYS);
    if (picked) groupBy = picked;
    else warnings.push(`忽略未知的分组维度：${input.groupBy}`);
  }
  let detail: AiDetailLevel = parseDetail(text);
  if (input?.detail != null) {
    const picked = pickEnum(input.detail, AI_DETAIL_LEVELS);
    if (picked) detail = picked;
    else warnings.push(`忽略未知的明细程度：${input.detail}`);
  }

  // ---- 数据集：显式选择整体替换；否则文本命中；都没有 → 默认 ----
  let datasetKeys: string[] = [];
  if (Array.isArray(input?.datasets) && input.datasets.length > 0) {
    for (const raw of input.datasets) {
      const key = String(raw ?? '').trim();
      if (!key) continue;
      if (!datasetByKey(key)) {
        unknownDatasets.push(key);
        continue;
      }
      if (!datasetKeys.includes(key)) datasetKeys.push(key);
    }
  } else {
    datasetKeys = textDatasets.slice();
  }
  if (!datasetKeys.length) datasetKeys = [...DEFAULT_DATASET_KEYS];
  const limited = limitDatasets(datasetKeys, MAX_DATASETS);
  if (limited.truncated > 0) warnings.push(`数据集超过 ${MAX_DATASETS} 个，已截断 ${limited.truncated} 个`);
  datasetKeys = limited.keys;
  if (unknownDatasets.length) warnings.push(`忽略未知数据集：${unknownDatasets.join('、')}`);

  // ---- focus ----
  const focus: AiFocus[] = [];
  const explicitFocus = Array.isArray(input?.focus) ? input.focus : [];
  if (explicitFocus.length) {
    for (const raw of explicitFocus) {
      const picked = pickEnum(raw, AI_FOCUSES);
      if (picked) {
        if (!focus.includes(picked)) focus.push(picked);
      } else {
        warnings.push(`忽略未知关注点：${raw}`);
      }
    }
  } else {
    focus.push(...matchFocus(text));
  }

  // ---- 输出形态：默认只出报告；表格按需 ----
  const wantsWorkbook = /(表格|工作簿|xlsx|excel|导出表)/i.test(text);
  const outputs = {
    report: input?.outputs?.report ?? true,
    workbook: input?.outputs?.workbook ?? wantsWorkbook,
  };

  const intent: AiAnalyticsIntent = {
    version: 1,
    scope: {
      mode: scopeMode,
      // 项目名称提示由服务端用有权限项目去匹配；这里只透传前端给的提示
      mentions: Array.isArray(input?.scope?.mentions) ? input.scope.mentions.slice(0, 20) : undefined,
    },
    period: { preset, ...(preset === 'custom' ? { from, to } : {}) },
    datasets: datasetKeys,
    groupBy,
    detail,
    focus,
    outputs,
    reportKind,
    compare,
    notes,
    rawText: text || undefined,
  };

  return { intent, warnings, unknownTerms: [], unknownDatasets };
}
