import { Module } from '@nestjs/common';
import { ContractItemService } from './contract-item.service';
import { ContractItemController } from './contract-item.controller';

@Module({
  controllers: [ContractItemController],
  providers: [ContractItemService],
  exports: [ContractItemService],
})
export class ContractItemModule {}
