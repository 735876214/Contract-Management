import { Module } from '@nestjs/common';
import { PaymentProcedureService } from './payment-procedure.service';
import { PaymentProcedureController } from './payment-procedure.controller';

/** 付款手续（付款管理下的编制单据）。PrismaClient / DictService 由全局模块提供，无需 imports。 */
@Module({
  controllers: [PaymentProcedureController],
  providers: [PaymentProcedureService],
  exports: [PaymentProcedureService],
})
export class PaymentProcedureModule {}
