import { Module } from '@nestjs/common';
import { ArchiveService } from './archive.service';
import { ArchiveController } from './archive.controller';
import { LedgerModule } from '../ledger';
import { SettlementModule } from '../settlement';
import { InvoiceModule } from '../invoice';
import { PaymentModule } from '../payment';
import { AssetModule } from '../asset';
import { DailyReportModule } from '../daily-report';
import { RepaymentModule } from '../repayment';
import { FinanceModule } from '../finance';
import { CostModule } from '../cost';

/** 项目资料归档（附件需求 2026-10-17）：依赖各业务模块的导出 service（全部已 exports）。 */
@Module({
  imports: [
    LedgerModule,
    SettlementModule,
    InvoiceModule,
    PaymentModule,
    AssetModule,
    DailyReportModule,
    RepaymentModule,
    FinanceModule,
    CostModule,
  ],
  controllers: [ArchiveController],
  providers: [ArchiveService],
  exports: [ArchiveService],
})
export class ArchiveModule {}
