import { Module } from '@nestjs/common';
import { FinalSettlementService } from './final-settlement.service';
import { FinalSettlementController } from './final-settlement.controller';
import { ContractModule } from '../contract/contract.module';
import { DocTemplateModule } from '../doc-template/doc-template.module';

/**
 * 总结算单。
 * - `ContractModule`：附件上传后要把合同置「已完已结」并重算付款比例（`syncPayRatio` 是唯一派生实现）；
 * - `DocTemplateModule`：导出 Word 走单据模板（分类 `FINAL_SETTLEMENT`）。
 * 两个模块都不依赖本模块，无循环。
 */
@Module({
  imports: [ContractModule, DocTemplateModule],
  controllers: [FinalSettlementController],
  providers: [FinalSettlementService],
  exports: [FinalSettlementService],
})
export class FinalSettlementModule {}
