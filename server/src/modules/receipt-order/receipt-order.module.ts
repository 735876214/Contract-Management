import { Module } from '@nestjs/common';
import { ReceiptOrderService } from './receipt-order.service';
import { ReceiptOrderController } from './receipt-order.controller';

/** 收领单模块（日报管理 → 收领单，与总日报平级）；DictModule 为全局模块无需重复导入 */
@Module({
  controllers: [ReceiptOrderController],
  providers: [ReceiptOrderService],
  exports: [ReceiptOrderService],
})
export class ReceiptOrderModule {}
