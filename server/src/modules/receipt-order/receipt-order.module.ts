import { Module } from '@nestjs/common';
import { ReceiptOrderService } from './receipt-order.service';
import { ReceiptOrderController } from './receipt-order.controller';
import { SettlementModule } from '../settlement/settlement.module';

/**
 * 收领单模块（日报管理 → 收领单，与总日报平级）；DictModule 为全局模块无需重复导入。
 * `SettlementModule`：收领单要挂到结算单上（业务口径 2026-10-16「收领单仅与结算单对应」）。
 */
@Module({
  imports: [SettlementModule],
  controllers: [ReceiptOrderController],
  providers: [ReceiptOrderService],
  exports: [ReceiptOrderService],
})
export class ReceiptOrderModule {}
