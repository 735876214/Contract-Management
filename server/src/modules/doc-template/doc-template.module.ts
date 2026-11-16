import { Module } from '@nestjs/common';
import { DocTemplateService } from './doc-template.service';
import { DocTemplateController } from './doc-template.controller';

/** 单据模板（基础信息管理）。PrismaClient / DictService 由全局模块提供。 */
@Module({
  controllers: [DocTemplateController],
  providers: [DocTemplateService],
  exports: [DocTemplateService],
})
export class DocTemplateModule {}
