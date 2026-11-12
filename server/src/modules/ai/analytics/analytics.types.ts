/**
 * AI 经营数据助手 · 意图与事实的**共享类型**（零依赖，可被 `.mts` 直接加载）。
 *
 * 口径约定（2026-11-12 评审确认）：
 * - 意图只由枚举/白名单组成，**不含任何数字、日期、项目 ID**；
 * - 对比方式 `compare` 单选：`mom` 环比（紧邻本期前、等长段）/ `yoy` 同比（各回退一年）；
 * - 报告章节用**稳定英文 ID**，中文标题与编号在展示层映射（改文案不断解析）。
 */

export type AiPeriodPreset =
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  | 'last_30_days'
  | 'last_90_days'
  | 'ytd'
  | 'all'
  | 'custom';

/** 对比口径：环比 / 同比单选；`all` 或参照期无数据时归一为 `none` */
export type AiCompareMode = 'none' | 'mom' | 'yoy';

export type AiScopeMode = 'current' | 'selected' | 'all';

export type AiReportKind = 'monthly' | 'project' | 'brief' | 'custom' | 'comparison';

export type AiGroupBy = 'project' | 'month' | 'supplier' | 'contract';

export type AiDetailLevel = 'summary' | 'detail' | 'both';

export type AiFocus =
  | 'payment_risk'
  | 'invoice_gap'
  | 'cost_overrun'
  | 'schedule'
  | 'supplier_concentration'
  | 'procurement'
  | 'asset';

/**
 * 报告章节 ID（稳定标识）：中文标题、显示顺序、编号由展示层按报告类型决定。
 * `overview` / `risks` / `advice` 不是数据集，由事实包与模板直接产出。
 */
export type AiReportSectionId =
  | 'overview'
  | 'projects'
  | 'contracts'
  | 'fulfillment'
  | 'settlements'
  | 'funds'
  | 'cost'
  | 'labor'
  | 'procurement'
  | 'daily'
  | 'assets'
  | 'materials'
  | 'supplier'
  | 'risks'
  | 'advice';

export interface AiAnalyticsScope {
  mode: AiScopeMode;
  /** 项目名称/简称提示（服务端在有权限项目里匹配；**不是 ID**） */
  mentions?: string[];
}

export interface AiAnalyticsIntent {
  version: 1;
  scope: AiAnalyticsScope;
  period: { preset: AiPeriodPreset; from?: string; to?: string };
  /** 注册表 key；最多 8 个 */
  datasets: string[];
  groupBy: AiGroupBy;
  detail: AiDetailLevel;
  focus: AiFocus[];
  outputs: { report: boolean; workbook: boolean };
  reportKind: AiReportKind;
  compare: AiCompareMode;
  /** ≤300 字，只进写作提示，不影响取数 */
  notes?: string;
  /** ≤2000 字，落库回看 */
  rawText?: string;
}

/** `POST /plan` 的返回：最终意图 + 解析提醒 + 有权限的项目集合 */
export interface AiAnalyticsPlanResult {
  intent: AiAnalyticsIntent;
  warnings: string[];
  unknownTerms: string[];
  unknownDatasets: string[];
  deniedDatasets: string[];
  projects: Array<{ id: string; code: string; name: string }>;
  source: 'rules' | 'llm';
}

export const AI_PERIOD_PRESETS: readonly AiPeriodPreset[] = [
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'last_30_days',
  'last_90_days',
  'ytd',
  'all',
  'custom',
];

export const AI_COMPARE_MODES: readonly AiCompareMode[] = ['none', 'mom', 'yoy'];
export const AI_SCOPE_MODES: readonly AiScopeMode[] = ['current', 'selected', 'all'];
export const AI_REPORT_KINDS: readonly AiReportKind[] = ['monthly', 'project', 'brief', 'custom', 'comparison'];
export const AI_GROUP_BYS: readonly AiGroupBy[] = ['project', 'month', 'supplier', 'contract'];
export const AI_DETAIL_LEVELS: readonly AiDetailLevel[] = ['summary', 'detail', 'both'];
export const AI_FOCUSES: readonly AiFocus[] = [
  'payment_risk',
  'invoice_gap',
  'cost_overrun',
  'schedule',
  'supplier_concentration',
  'procurement',
  'asset',
];
export const AI_REPORT_SECTIONS: readonly AiReportSectionId[] = [
  'overview',
  'projects',
  'contracts',
  'fulfillment',
  'settlements',
  'funds',
  'cost',
  'labor',
  'procurement',
  'daily',
  'assets',
  'materials',
  'supplier',
  'risks',
  'advice',
];

/** 章节中文标题（展示层映射；模型只认 ID） */
export const AI_SECTION_TITLES: Record<AiReportSectionId, string> = {
  overview: '经营总览',
  projects: '项目概况',
  contracts: '合同情况',
  fulfillment: '履约进度',
  settlements: '结算与资金',
  funds: '资金费用',
  cost: '成本管理',
  labor: '劳务与分包',
  procurement: '采购执行',
  daily: '日报与收领单',
  assets: '资产进出场',
  materials: '物资与合同清单',
  supplier: '供应商结构',
  risks: '风险与提示',
  advice: '建议',
};
