import { Module } from '@nestjs/common';
import { RepaymentService } from './repayment.service';
import { RepaymentController } from './repayment.controller';

@Module({
  controllers: [RepaymentController],
  providers: [RepaymentService],
  exports: [RepaymentService],
})
export class RepaymentModule {}
