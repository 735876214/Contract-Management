import { Module } from '@nestjs/common';
import { SubcontractorService } from './subcontractor.service';
import { SubcontractorController } from './subcontractor.controller';

@Module({
  controllers: [SubcontractorController],
  providers: [SubcontractorService],
  exports: [SubcontractorService],
})
export class SubcontractorModule {}
