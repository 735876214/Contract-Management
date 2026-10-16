import { Module } from '@nestjs/common';
import { InvoiceService } from './invoice.service';
import { InvoiceController } from './invoice.controller';
import { SettlementModule } from '../settlement/settlement.module';

/**
 * `SettlementModule`：发票要挂到结算单上（业务口径 2026-10-16「发票与结算单对应」），
 * 自动匹配与关联校验都在 `SettlementService`（结算口径的唯一实现）。无循环依赖（结算模块不反向依赖发票）。
 */
@Module({
  imports: [SettlementModule],
  controllers: [InvoiceController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
