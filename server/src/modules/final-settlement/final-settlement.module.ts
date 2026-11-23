import { Module } from '@nestjs/common';
import { FinalSettlementService } from './final-settlement.service';
import { FinalSettlementController } from './final-settlement.controller';
import { ContractModule } from '../contract';

/**
 * 总结算单。
 * - `ContractModule`：附件上传后要把合同置「已完已结」并重算付款比例（`syncPayRatio` 是唯一派生实现）。
 * 导出已改为**内置模板直接渲染**（`final-settlement-excel.ts`），不再依赖 `DocTemplateModule`。
 */
@Module({
  imports: [ContractModule],
  controllers: [FinalSettlementController],
  providers: [FinalSettlementService],
  exports: [FinalSettlementService],
})
export class FinalSettlementModule {}
