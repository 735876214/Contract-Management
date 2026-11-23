import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai-core/ai-core.module.ts';
import { AiService } from './ai.service.ts';
import { FieldResolverService } from './field-resolver.service.ts';
import { ReportService } from './report.service.ts';
import { AnomalyService } from './anomaly/anomaly.service.ts';
import { ScmService } from './analysis/scm.service.ts';
import { AnalyticsService } from './analytics/analytics.service.ts';
import { AnalyticsController } from './analytics/analytics.controller.ts';
import { AnalyticsStore } from './analytics/analytics-store.service.ts';
import { DatasetCollector } from './analytics/dataset-collector.service.ts';
import { IntentService } from './intent/intent.service.ts';

/**
 * **AI 只读分析模块**：数据集/经营分析、异常预警、供应链全景（SCM）、报告、字段取值。
 *
 * 铁律（检查器 `AI_READ_ONLY_DIRS` + `AI_OWN_MODELS` 锁定）：本模块**不得依赖业务模块**，
 * 也**不得直接查业务表**——取数一律走 `server/src/query/`（`load*` / `ai-dataset-queries` /
 * `ai-anomaly-queries`）。原因是分析与预警必须能脱离业务逻辑单独跑，否则口径会跟着业务改。
 */
@Module({
  imports: [AiCoreModule],
  controllers: [AnalyticsController],
  providers: [
    AiService,
    FieldResolverService,
    ReportService,
    AnomalyService,
    ScmService,
    AnalyticsService,
    AnalyticsStore,
    DatasetCollector,
    IntentService,
  ],
  exports: [
    AiService,
    FieldResolverService,
    ReportService,
    AnomalyService,
    ScmService,
    AnalyticsService,
    AnalyticsStore,
    DatasetCollector,
    IntentService,
  ],
})
export class AiInsightModule {}
