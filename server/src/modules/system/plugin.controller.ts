import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth';
import { PermissionsGuard } from '../auth';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { PluginService } from './plugin.service';

/**
 * 插件管理接口（系统管理 → 插件管理）。
 *
 * **只读**：构建期插件的启停靠 `plugin.json` + `CMS_PLUGINS_DISABLED` 环境变量 + 重启，
 * 详情与理由见 `PluginService` 的类注释。权限沿用 `system:config`（改的是全站装配，
 * 不是业务数据）。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('system/plugins')
export class PluginController {
  constructor(private readonly service: PluginService) {}

  @RequirePermissions('system:config')
  @Get()
  list() {
    return this.service.list();
  }
}
