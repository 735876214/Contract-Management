import { Module } from '@nestjs/common';
import { ContractModule } from '../contract/contract.module';
import { SupplierModule } from '../supplier/supplier.module';
import { AiController } from './ai.controller';
import { AiQuota } from './ai-quota';
import { AiService } from './ai.service';
import { FieldResolverService } from './field-resolver.service';
import { RegisterService } from './register.service';

/**
 * AI 助手模块（纯增量能力：不引入新依赖、不改任何既有表）。
 * 配置全部来自环境变量，见 `ai-config.ts`；未配置时接口返回 `enabled:false`，前端提示配置项。
 *
 * 登记写库**不另起捷径**：复用 `ContractService.create` / `SupplierService.create`，
 * 编号唯一、名称拼接、字典校验、付款比例派生、供应商重名这些既有约束自动生效。
 */
@Module({
  imports: [ContractModule, SupplierModule],
  controllers: [AiController],
  providers: [AiService, FieldResolverService, RegisterService, AiQuota],
  exports: [AiService, FieldResolverService, RegisterService],
})
export class AiModule {}
