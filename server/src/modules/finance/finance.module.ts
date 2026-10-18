import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { SettlementModule } from '../settlement/settlement.module';
import { ContractModule } from '../contract/contract.module';
import { FinanceService } from './finance.service';

/**
 * `ContractModule`：updateContractParams 改付款模式后要重算「当前生效付款比例」
 * （`syncPayRatio` 是唯一派生实现，在 ContractService 上）。
 * ContractModule 不依赖本模块，无循环。
 */
@Module({
  imports: [SettlementModule, ContractModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
