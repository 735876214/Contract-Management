/**
 * ai-insight 模块对外公开入口（只读分析与预警（数据集、经营分析、异常检测、报告））。
 *
 * 其他模块只允许 `from '../ai-insight/index.ts'`；直接引内部文件会被 `scripts/check-module-boundaries.mjs` 判为越界。
 * 下面只导出**别的模块真正需要的符号**（按调用方实际 import 生成，不是 export *）。
 */
export { AiInsightModule } from './ai-insight.module.ts';

export { AiService } from './ai.service.ts';
export { ScmService } from './analysis/scm.service.ts';
export type { ScmAnalysisQuery } from './analysis/scm.service.ts';
export { AnalyticsStore } from './analytics/analytics-store.service.ts';
export { AnalyticsController } from './analytics/analytics.controller.ts';
export { AnalyticsService } from './analytics/analytics.service.ts';
export { DatasetCollector } from './analytics/dataset-collector.service.ts';
export { AnomalyService } from './anomaly/anomaly.service.ts';
export type { PaymentAnomalyQuery } from './anomaly/anomaly.service.ts';
export { FieldResolverService } from './field-resolver.service.ts';
export { IntentService } from './intent/intent.service.ts';
export { ReportService } from './report.service.ts';
// 口径提示词目录：对外（MCP prompts）暴露同一份正文，不复制第二份
export { AI_PROMPT_CATALOG, AI_PROMPT_MAP, listAiPrompts, renderAiPrompt } from './prompt-catalog.ts';
// 口径上下文（MCP resources + 站内问数工具共用；放这里是因为 chat 工具要读它，
// 而 ai-insight 不能被 modules/ai 反向依赖）
export { CONTEXT_DOC_MAP, listContextDocs, renderContextDoc } from './context-catalog.ts';
export type { ContextDocMeta, ContextKey } from './context-catalog.ts';
export type { AiPromptArgument, AiPromptDef } from './prompt-catalog.ts';
export { ChatRunService } from './analytics/chat-run.service.ts';
