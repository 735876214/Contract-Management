import { Module } from '@nestjs/common';
import { ContractModule } from '../contract/index.ts';
import { SupplierModule } from '../supplier/index.ts';
import { AiCoreModule } from '../ai-core/ai-core.module.ts';
import { RegisterService } from './register.service.ts';
import { QuoteService } from './quote/quote.service.ts';
import { FulfillmentService } from './fulfillment/fulfillment.service.ts';

/**
 * **AI 写作/取价模块**：单据登记（register）、报价与价差、履约偏差。
 *
 * 与 `ai-insight` 相反，本模块**必须**依赖业务模块：`register.service` 刻意复用
 * `ContractService.create` / `SupplierService.create`，编号唯一、名称拼接、字典校验、
 * 付款比例派生、供应商重名等既有约束自动生效——这是刻意的写路径，不要「优化」成直接写表
 * （检查器 `AI_WRITE_PATH_ALLOWLIST` 只对这一条路径放行）。
 */
@Module({
  imports: [AiCoreModule, ContractModule, SupplierModule],
  providers: [RegisterService, QuoteService, FulfillmentService],
  exports: [RegisterService, QuoteService, FulfillmentService],
})
export class AiFillModule {}
