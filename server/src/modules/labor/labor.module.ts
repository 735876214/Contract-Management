import { Module } from '@nestjs/common';
import { LaborService } from './labor.service';
import { LaborController } from './labor.controller';
import { SubcontractorModule } from '../subcontractor/subcontractor.module';

/** 劳务管理（分包授权台账；附件需求 2026-10-17）。SubcontractorModule 提供分包商档案快照来源。 */
@Module({
  imports: [SubcontractorModule],
  controllers: [LaborController],
  providers: [LaborService],
  exports: [LaborService],
})
export class LaborModule {}
