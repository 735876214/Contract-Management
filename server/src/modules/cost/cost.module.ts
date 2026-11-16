import { Module } from '@nestjs/common';
import { LaborReceivingService } from './labor-receiving.service';
import { MonthlyProfitLossService } from './monthly-profit-loss.service';
import { CostController } from './cost.controller';

/** 成本管理（分包领用汇总 + 分包单位领用月度汇总 + 月度盈亏分析；附件需求 2026-10-17）。PrismaClient 由全局模块提供。 */
@Module({
  controllers: [CostController],
  providers: [LaborReceivingService, MonthlyProfitLossService],
  exports: [LaborReceivingService, MonthlyProfitLossService],
})
export class CostModule {}
