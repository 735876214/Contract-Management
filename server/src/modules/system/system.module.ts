import { Module } from '@nestjs/common';
import { SystemService } from './system.service';
import { SystemController } from './system.controller';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { PluginController } from './plugin.controller';
import { McpAuditController } from './mcp-audit.controller';
import { McpAuditService } from './mcp-audit.service';
import { PluginService } from './plugin.service';

@Module({
  controllers: [SystemController, MenuController, PluginController, McpAuditController],
  providers: [SystemService, MenuService, PluginService, McpAuditService],
  exports: [SystemService, MenuService],
})
export class SystemModule {}
