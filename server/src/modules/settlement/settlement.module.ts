import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { SettlementLedgerService } from './settlement-ledger.service';
import { SettlementController } from './settlement.controller';

@Module({
  controllers: [SettlementController],
  providers: [SettlementService, SettlementLedgerService],
  exports: [SettlementService],
})
export class SettlementModule {}
