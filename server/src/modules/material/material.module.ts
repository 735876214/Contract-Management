import { Module } from '@nestjs/common';
import { MaterialController } from './material.controller';
import { MaterialService } from './material.service';
import { DictModule } from '../dict/dict.module';
import { SettlementModule } from '../settlement/settlement.module';

@Module({
  imports: [DictModule, SettlementModule],
  controllers: [MaterialController],
  providers: [MaterialService],
  exports: [MaterialService],
})
export class MaterialModule {}
