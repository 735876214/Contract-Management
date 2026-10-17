import { Module } from '@nestjs/common';
import { LaborService } from './labor.service';
import { LaborController } from './labor.controller';

/** 劳务管理 · 分包授权台账（原「分包商库」并入本模块，附件需求 2026-10-17）。 */
@Module({
  controllers: [LaborController],
  providers: [LaborService],
  exports: [LaborService],
})
export class LaborModule {}
