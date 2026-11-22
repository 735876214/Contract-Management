import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, ProjectId } from '../../common/decorators/user.decorator';
import { IMPORT_UPLOAD_OPTIONS } from '../../common/utils/upload-rules';
import { sendFile } from '../../common/http/download';
import { noFileImportResult, noFileImportResultLegacyNoUpdate } from '../../common/utils/import-result';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('payments')
export class PaymentController {
  constructor(private service: PaymentService) {}

  // ---------- 付款执行 / 台账 ----------
  @RequirePermissions('payment:view')
  @Get('records')
  findRecords(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findRecords(query, projectId);
  }

  @RequirePermissions('payment:view')
  @Get('records/export')
  async exportRecords(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.service.exportRecords(projectId);
    sendFile(res, 'payment-records.xlsx', buffer, 'xlsx');
  }

  /** 下载填写模板（需求 3.3） */
  @RequirePermissions('payment:view')
  @Get('records/template')
  async templateRecords(@ProjectId() projectId: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.templateRecords(projectId);
    sendFile(res, filename, buffer, 'xlsx');
  }

  /** 上传导入数据（需求 3.4） */
  @RequirePermissions('payment:edit')
  @Post('records/import')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importRecords(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return noFileImportResultLegacyNoUpdate();
    return this.service.importRecords(file.buffer, projectId, { fileName: file?.originalname, user });
  }

  /** 上传前预校验（不写库） */
  @RequirePermissions('payment:edit')
  @Post('records/import/validate')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importRecordsValidate(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return noFileImportResult();
    return this.service.importRecords(file.buffer, projectId, { fileName: file?.originalname, user, validateOnly: true });
  }

  // @body: pickFields=RECORD_FIELDS
  @RequirePermissions('payment:edit')
  @Post('records')
  createRecord(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createRecord(body, projectId);
  }

  // @body: pickFields=RECORD_UPDATE_FIELDS
  @RequirePermissions('payment:edit')
  @Put('records/:id')
  updateRecord(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.updateRecord(id, body, projectId);
  }

  @RequirePermissions('payment:edit')
  @Delete('records/:id')
  removeRecord(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.removeRecord(id, projectId);
  }
}