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
  ],
})
export class AppModule {}
