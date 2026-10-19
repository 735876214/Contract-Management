import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { FieldResolverService } from './field-resolver.service';

/**
 * AI 助手模块（纯增量能力：不引入新依赖、不落盘、不改任何既有表）。
 * 配置全部来自环境变量，见 `ai-config.ts`；未配置时接口返回 `enabled:false`，前端隐藏入口。
 */
@Module({
  controllers: [AiController],
  providers: [AiService, FieldResolverService],
  exports: [AiService, FieldResolverService],
})
export class AiModule {}
