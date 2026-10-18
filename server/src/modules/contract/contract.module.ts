import { Module } from '@nestjs/common';
import { ContractService } from './contract.service';
import { ContractFulfillmentService } from './contract-fulfillment.service';
import { MilestoneService } from './milestone.service';
import { ContractController } from './contract.controller';
import { MaterialModule } from '../material/material.module';
import { TemplateModule } from '../template/template.module';

@Module({
  imports: [MaterialModule, TemplateModule],
  controllers: [ContractController],
  providers: [ContractService, ContractFulfillmentService, MilestoneService],
  exports: [ContractService, ContractFulfillmentService, MilestoneService],
})
export class ContractModule {}
