import { Module } from '@nestjs/common';
import { ProcurementTemplateController } from './procurement-template.controller';
import { ProcurementTemplateService } from './procurement-template.service';
import { ProcurementTaskController } from './procurement-task.controller';
import { ProcurementTaskService } from './procurement-task.service';
import { InspectionReportController } from './inspection-report.controller';
import { InspectionReportService } from './inspection-report.service';

/** 采购管理模块：采购模板管理（批次一）+ 采购任务工作流（批次二）+ 考察报告（任务 3.7，独立模块） */
@Module({
  controllers: [
    ProcurementTemplateController,
    ProcurementTaskController,
    InspectionReportController,
  ],
  providers: [ProcurementTemplateService, ProcurementTaskService, InspectionReportService],
})
export class ProcurementModule {}
