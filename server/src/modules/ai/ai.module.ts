import { Module } from '@nestjs/common';
import { ContractModule } from '../contract/contract.module';
import { SupplierModule } from '../supplier/supplier.module';
import { AiController } from './ai.controller';
import { AiQuota } from './ai-quota';
import { AiService } from './ai.service';
import { AiSettingService } from './ai-setting.service';
import { FieldResolverService } from './field-resolver.service';
import { RegisterService } from './register.service';
import { ReportService } from './report.service';
import { AnomalyService } from './anomaly/anomaly.service';
import { QuoteService } from './quote/quote.service';
import { FulfillmentService } from './fulfillment/fulfillment.service';
import { ScmService } from './analysis/scm.service';

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
  controllers: [AiController],
  providers: [AiService, AiSettingService, FieldResolverService, RegisterService, ReportService, AnomalyService, QuoteService, FulfillmentService, ScmService, AiQuota],
  exports: [AiService, AiSettingService, FieldResolverService, RegisterService, ReportService, AnomalyService, QuoteService, FulfillmentService, ScmService],
})
export class AiModule {}

