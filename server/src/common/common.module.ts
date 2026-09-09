import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SysParamService } from './services/sys-param.service';
import { ExcelService } from './services/excel.service';
import { LogService } from './services/log.service';
import { StyledExcelService } from './services/styled-excel.service';
import { ImportTemplateService } from './services/import-template.service';
import { ImportRunnerService } from './services/import-runner.service';
import { ImportTaskService } from './services/import-task.service';
import { ImportTaskController } from './import-task.controller';
import { NotificationModule } from '../modules/notification/notification.module';

@Global()
@Module({
  imports: [NotificationModule],
  controllers: [ImportTaskController],
  providers: [
    SysParamService, ExcelService, LogService, StyledExcelService, ImportTemplateService,
    ImportRunnerService, ImportTaskService,
  ],
  exports: [
    SysParamService, ExcelService, LogService, StyledExcelService, ImportTemplateService,
    ImportRunnerService, ImportTaskService,
  ],
})
export class CommonModule {}

/** PrismaClient 由全局 PrismaModule 提供，此处仅做类型再导出，方便其它模块引用 */
export { PrismaClient };
