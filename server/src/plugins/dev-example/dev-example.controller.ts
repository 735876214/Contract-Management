import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../modules/auth';
import { PermissionsGuard } from '../../modules/auth';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { DevExampleService } from './dev-example.service';

/**
 * 插件自己的接口面。
 *
 * 约定（`scripts/gen-plugins.mjs` 会校验）：
 * - 路由前缀必须与 `plugin.json` 的 `apiPrefix` 一致；
 * - 每个接口都要 `@RequirePermissions('<插件名>:<动作>')`，权限码登记在 `plugin.json`；
 * - **只读**演示：写接口要过 `scripts/check-body-whitelist.mjs`，示例插件刻意不碰。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('plugin/dev-example')
export class DevExampleController {
  constructor(private readonly service: DevExampleService) {}

  /** 返回本插件的装配事实（模块/接口/权限/菜单/页面），用于验证"插件确实生效了" */
  @RequirePermissions('dev-example:view')
  @Get('summary')
  summary() {
    return this.service.summary();
  }
}
