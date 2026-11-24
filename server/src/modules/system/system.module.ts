import { Module } from '@nestjs/common';
import { SystemService } from './system.service';
import { SystemController } from './system.controller';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { PluginController } from './plugin.controller';
import { PluginService } from './plugin.service';

@Module({
  controllers: [SystemController, MenuController, PluginController],
  providers: [SystemService, MenuService, PluginService],
  exports: [SystemService, MenuService],
})
export class SystemModule {}
