import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.ts';
import { AiCoreModule } from '../ai-core/ai-core.module.ts';
import { AiFillModule } from '../ai-fill/index.ts';
import { AiInsightModule } from '../ai-insight/index.ts';

/**
 * **AI 装配模块**：只做三件事——把三个子模块接起来、挂路由、把 AI 能力暴露给 app。
 *
 * 为什么要拆成三个 Nest 模块（2026-11-24，P4 收尾）：原先 14 个 provider 全挤在这一个
 * `@Module` 里，「只读分析不得依赖业务模块」这条只能用目录路径去锁；拆开之后**依赖方向由 DI 图
 * 直接表达**：`AiInsightModule` 的 `imports` 里没有业务模块，想注入 `ContractService` 会直接编译失败；
 * `AiFillModule` 显式 `imports: [ContractModule, SupplierModule]`，写路径的例外一目了然。
 *
 * 登记写库**不另起捷径**：复用 `ContractService.create` / `SupplierService.create`（见 AiFillModule）。
 */
@Module({
  imports: [AiCoreModule, AiInsightModule, AiFillModule],
  controllers: [AiController],
  exports: [AiInsightModule, AiFillModule, AiCoreModule],
})
export class AiModule {}
