import { Module } from '@nestjs/common';
import { ContractService } from './contract.service';
import { ContractDraftService } from './contract-draft.service';
import { ContractFulfillmentService } from './contract-fulfillment.service';
import { MilestoneService } from './milestone.service';
import { ContractController } from './contract.controller';
import { MaterialModule } from '../material';
import { TemplateModule } from '../template';

@Module({
  imports: [MaterialModule, TemplateModule],
  controllers: [ContractController],
  providers: [ContractService, ContractDraftService, ContractFulfillmentService, MilestoneService],
  exports: [ContractService, ContractFulfillmentService, MilestoneService],
})
export class ContractModule {}
