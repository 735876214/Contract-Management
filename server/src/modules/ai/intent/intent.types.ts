/**
 * AI 经营数据助手 · 意图解析的输入类型。
 *
 * 与 `AiAnalyticsIntent` 的区别：这里是**用户请求的原始形状**（含前端结构化选择与自由文本），
 * `parseIntentRules()` 把它归一成白名单枚举的意图。模型（Phase 3）只补 `mentions` 级别的提示，
 * 永不输出 ID / 日期 / 数字。
 */

import type { AiAnalyticsIntent } from '../analytics/analytics.types.ts';

export interface AiAnalyticsPlanInput {
  /** 一段自然语言（≤2000 字） */
  text?: string;
  scope?: {
    mode?: string;
    /** 项目名称/简称提示 */
    mentions?: string[];
    /** 前端结构化多选（服务端按成员关系收口；不来自模型） */
    projectIds?: string[];
  };
  period?: { preset?: string; from?: string; to?: string };
  /** 前端显式选择的数据集：非空时**整体替换**文本解析结果（不做并集） */
  datasets?: string[];
  focus?: string[];
  outputs?: { report?: boolean; workbook?: boolean };
  reportKind?: string;
  compare?: string;
  groupBy?: string;
  detail?: string;
  /** ≤300 字，只进写作提示 */
  notes?: string;
}

export interface RulesParseResult {
  intent: AiAnalyticsIntent;
  warnings: string[];
  unknownTerms: string[];
  unknownDatasets: string[];
}
