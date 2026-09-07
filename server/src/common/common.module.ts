import { Global, Module } from '@nestjs/common';
import { SysParamService } from './services/sys-param.service';
import { ExcelService } from './services/excel.service';
import { LogService } from './services/log.service';

@Global()
@Module({
  providers: [SysParamService, ExcelService, LogService],
  exports: [SysParamService, ExcelService, LogService],
})
export class CommonModule {}
