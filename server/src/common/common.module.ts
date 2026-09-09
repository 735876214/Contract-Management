import { Global, Module } from '@nestjs/common';
import { SysParamService } from './services/sys-param.service';
import { ExcelService } from './services/excel.service';
import { LogService } from './services/log.service';
import { StyledExcelService } from './services/styled-excel.service';
import { ImportTemplateService } from './services/import-template.service';

@Global()
@Module({
  providers: [SysParamService, ExcelService, LogService, StyledExcelService, ImportTemplateService],
  exports: [SysParamService, ExcelService, LogService, StyledExcelService, ImportTemplateService],
})
export class CommonModule {}
