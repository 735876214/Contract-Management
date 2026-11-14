import { Module } from '@nestjs/common';
import { MaterialController } from './material.controller';
import { MaterialService } from './material.service';
import { DictModule } from '../dict';
import { SettlementModule } from '../settlement';

@Module({
  imports: [DictModule, SettlementModule],
  controllers: [MaterialController],
  providers: [MaterialService],
  exports: [MaterialService],
})
export class MaterialModule {}
