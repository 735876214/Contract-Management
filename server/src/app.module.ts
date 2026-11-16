import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { DictModule } from './modules/dict/dict.module';
import { ProjectModule } from './modules/project/project.module';
import { SupplierModule } from './modules/supplier/supplier.module';
import { ContractModule } from './modules/contract/contract.module';
import { TemplateModule } from './modules/template/template.module';
import { DailyReportModule } from './modules/daily-report/daily-report.module';
import { MaterialModule } from './modules/material/material.module';
import { SettlementModule } from './modules/settlement/settlement.module';
import { PaymentModule } from './modules/payment/payment.module';
import { InvoiceModule } from './modules/invoice/invoice.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { RepaymentModule } from './modules/repayment/repayment.module';
import { FinanceModule } from './modules/finance/finance.module';
import { NotificationModule } from './modules/notification/notification.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SystemModule } from './modules/system/system.module';
import { FileModule } from './modules/file/file.module';
import { AssetModule } from './modules/asset/asset.module';
import { ReceiptOrderModule } from './modules/receipt-order/receipt-order.module';

import { ProcurementModule } from './modules/procurement/procurement.module';
import { PaymentProcedureModule } from './modules/payment-procedure/payment-procedure.module';
import { DocTemplateModule } from './modules/doc-template/doc-template.module';
import { FinalSettlementModule } from './modules/final-settlement/final-settlement.module';
import { LaborModule } from './modules/labor/labor.module';
import { CostModule } from './modules/cost/cost.module';
import { ArchiveModule } from './modules/archive/archive.module';
import { AiModule } from './modules/ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CommonModule,
    AuthModule,
    DictModule,
    ProjectModule,
    SupplierModule,
    ContractModule,
    TemplateModule,
    DailyReportModule,
    MaterialModule,
    SettlementModule,
    PaymentModule,
    InvoiceModule,
    LedgerModule,
    RepaymentModule,
    FinanceModule,
    NotificationModule,
    DashboardModule,
    SystemModule,
    FileModule,
    AssetModule,
    ReceiptOrderModule,

    ProcurementModule,
    PaymentProcedureModule,
    DocTemplateModule,
    FinalSettlementModule,
    LaborModule,
    CostModule,
    ArchiveModule,
    AiModule,
  ],
})
export class AppModule {}
