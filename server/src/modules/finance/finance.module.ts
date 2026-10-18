import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { SettlementModule } from '../settlement/settlement.module';
import { FinanceService } from './finance.service';

@Module({
  imports: [SettlementModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
