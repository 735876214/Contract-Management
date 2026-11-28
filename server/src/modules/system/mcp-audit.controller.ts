import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth';
import { PermissionsGuard } from '../auth';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { McpAuditService } from './mcp-audit.service';

/**
 * MCP 调用审计接口（系统管理 → MCP 调用）。
 *
 * 权限沿用 `system:config`：看的是全站 AI 调用面，与「插件管理」同档；
 * 业务数据本身不在这里暴露（只有工具名/耗时/结果/URL），所以不需要按项目隔离。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('system/mcp')
export class McpAuditController {
  constructor(private readonly service: McpAuditService) {}

  /** 概览：最近 30 天按工具聚合（次数/失败率/平均耗时/最近一次） */
  @RequirePermissions('system:config')
  @Get('overview')
  overview() {
    return this.service.overview();
  }

  /** 明细：支持 tool / result / keyword（URL、用户名、请求 id）与分页 */
  @RequirePermissions('system:config')
  @Get('calls')
  calls(@Query() query: Record<string, unknown>) {
    return this.service.calls(query || {});
  }
}
