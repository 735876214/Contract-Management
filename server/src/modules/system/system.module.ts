import { Module } from '@nestjs/common';
import { SystemService } from './system.service';
import { SystemController } from './system.controller';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';

@Module({
  controllers: [SystemController, MenuController],
  providers: [SystemService, MenuService],
  exports: [SystemService, MenuService],
})
export class SystemModule {}
