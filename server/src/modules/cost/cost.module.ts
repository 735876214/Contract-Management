import { Module } from '@nestjs/common';
import { CostService } from './cost.service';
import { LaborReceivingService } from './labor-receiving.service';
import { CostController } from './cost.controller';

/** 成本管理（分包领用汇总 + 盈亏分析 + 劳务队领用月度汇总；附件需求 2026-10-17）。PrismaClient 由全局模块提供。 */
@Module({
  controllers: [CostController],
  providers: [CostService, LaborReceivingService],
  exports: [CostService],
})
export class CostModule {}
