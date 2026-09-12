import { Module } from '@nestjs/common';
import { ProcurementTemplateController } from './procurement-template.controller';
import { ProcurementTemplateService } from './procurement-template.service';
import { ProcurementTaskController } from './procurement-task.controller';
import { ProcurementTaskService } from './procurement-task.service';
import { ContractModule } from '../contract/contract.module';

/** 采购管理模块：采购模板管理（批次一）+ 采购任务工作流（批次二） */
@Module({
  imports: [ContractModule],
  controllers: [ProcurementTemplateController, ProcurementTaskController],
  providers: [ProcurementTemplateService, ProcurementTaskService],
})
export class ProcurementModule {}
