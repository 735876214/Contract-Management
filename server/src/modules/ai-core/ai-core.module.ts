import { Module } from '@nestjs/common';
import { AiQuota } from './ai-quota.ts';
import { AiSettingService } from './ai-setting.service.ts';

/**
 * **AI 底座模块**（P4 收尾：目录边界升级成 DI 边界）。
 *
 * 只提供两样东西：LLM 配额（`AiQuota`）与 AI 设置读取（`AiSettingService`）。
 * 其余都是**纯函数**（LLM 客户端、提示词、字段目录、单据文本解析、金额与时间原语），
 * 按文件引用、不需要 DI，因此不在本模块的 providers 里（见 module-boundaries §2.6 的「库型目录」）。
 *
 * 依赖只有 `@Global()` 的 `PrismaModule` / `CommonModule`（`SysParamService`），零业务模块。
 */
@Module({
  providers: [AiQuota, AiSettingService],
  exports: [AiQuota, AiSettingService],
})
export class AiCoreModule {}
