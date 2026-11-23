/**
 * ai-insight 模块对外公开入口（只读分析与预警（数据集、经营分析、异常检测、报告））。
 *
 * 其他模块只允许 `from '../ai-insight/index.ts'`；直接引内部文件会被 `scripts/check-module-boundaries.mjs` 判为越界。
 * 下面只导出**别的模块真正需要的符号**（按调用方实际 import 生成，不是 export *）。
 */

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
