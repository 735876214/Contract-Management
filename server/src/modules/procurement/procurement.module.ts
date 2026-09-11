import { Module } from '@nestjs/common';
import { ProcurementTemplateController } from './procurement-template.controller';
import { ProcurementTemplateService } from './procurement-template.service';

/** 采购管理模块（批次一）：当前包含采购模板管理，后续批次扩展采购发起/公告/成交报告等 */
@Module({
  controllers: [ProcurementTemplateController],
  providers: [ProcurementTemplateService],
})
export class ProcurementModule {}
