import { Module } from '@nestjs/common';
import { ContractService } from './contract.service';
import { ContractController } from './contract.controller';
import { MaterialModule } from '../material/material.module';
import { TemplateModule } from '../template/template.module';

@Module({
  imports: [MaterialModule, TemplateModule],
  controllers: [ContractController],
  providers: [ContractService],
  exports: [ContractService],
})
export class ContractModule {}
