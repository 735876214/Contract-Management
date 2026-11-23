import { Module } from '@nestjs/common';
import { ContractModule } from '../contract';
import { SupplierModule } from '../supplier';
import { AiController } from './ai.controller.ts';
import { AiQuota } from '../ai-core/ai-quota.ts';
import { AiService } from '../ai-insight/index.ts';
import { AiSettingService } from '../ai-core/ai-setting.service.ts';
import { FieldResolverService } from '../ai-insight/index.ts';
import { RegisterService } from '../ai-fill/index.ts';
import { ReportService } from '../ai-insight/index.ts';
import { AnomalyService } from '../ai-insight/index.ts';
import { QuoteService } from '../ai-fill/index.ts';
import { FulfillmentService } from '../ai-fill/index.ts';
import { ScmService } from '../ai-insight/index.ts';
import { AnalyticsController } from '../ai-insight/index.ts';
import { AnalyticsService } from '../ai-insight/index.ts';
import { DatasetCollector } from '../ai-insight/index.ts';
import { AnalyticsStore } from '../ai-insight/index.ts';
import { IntentService } from '../ai-insight/index.ts';

/**
 * AI 助手模块（纯增量能力：不引入新依赖、不改任何既有表）。
 *
 * 配置来源（优先级见 `ai-config.ts`）：**系统管理 → AI 信息登记**（存 `SysParam`，保存即生效）
 * > 环境变量 `AI_*`。两者都没配时接口返回 `enabled:false`，前端提示去登记。
 *
 * 登记写库**不另起捷径**：复用 `ContractService.create` / `SupplierService.create`，
 * 编号唯一、名称拼接、字典校验、付款比例派生、供应商重名这些既有约束自动生效。
 */
@Module({
  imports: [ContractModule, SupplierModule],
  controllers: [AiController, AnalyticsController],
  providers: [AiService, AiSettingService, FieldResolverService, RegisterService, ReportService, AnomalyService, QuoteService, FulfillmentService, ScmService, AnalyticsService, DatasetCollector, AnalyticsStore, IntentService, AiQuota],
  exports: [AiService, AiSettingService, FieldResolverService, RegisterService, ReportService, AnomalyService, QuoteService, FulfillmentService, ScmService, AnalyticsService],
})
export class AiModule {}

