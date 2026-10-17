import { Module } from '@nestjs/common';
import { ArchiveService } from './archive.service';
import { ArchiveController } from './archive.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { SettlementModule } from '../settlement/settlement.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { PaymentModule } from '../payment/payment.module';
import { AssetModule } from '../asset/asset.module';
import { DailyReportModule } from '../daily-report/daily-report.module';
import { RepaymentModule } from '../repayment/repayment.module';
import { FinanceModule } from '../finance/finance.module';
import { CostModule } from '../cost/cost.module';

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
