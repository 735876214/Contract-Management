import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AssetService } from './asset.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';
import { IMPORT_UPLOAD_OPTIONS } from '../../common/utils/upload-rules';
import { sendFile } from '../../common/http/download';
import { noFileImportResult, noFileImportResultLegacyNoUpdate } from '../../common/utils/import-result';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('assets')
export class AssetController {
  constructor(private service: AssetService) {}

  @RequirePermissions('asset:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  /** 物资进出场汇总（零新表：按来源聚合数量/金额，2026-10-18） */
  @RequirePermissions('asset:view')
  @Get('flow-summary')
  flowSummary(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.flowSummary(projectId, query);
  }

  @RequirePermissions('asset:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.export(projectId);
    sendFile(res, filename, buffer, 'xlsx');
  }

  /** 下载填写模板（需求 3.3） */
  @RequirePermissions('asset:view')
  @Get('template')
  async template(@Res() res: Response) {
    const { buffer, filename } = await this.service.template();
    sendFile(res, filename, buffer, 'xlsx');
  }

  /** 上传导入数据（需求 3.4） */
  @RequirePermissions('asset:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importAssets(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return noFileImportResultLegacyNoUpdate();
    return this.service.importAssets(file.buffer, projectId, { fileName: file?.originalname, user });
  }

  /** 上传前预校验（不写库） */
  @RequirePermissions('asset:edit')
  @Post('import/validate')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importAssetsValidate(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return noFileImportResult();
    return this.service.importAssets(file.buffer, projectId, { fileName: file?.originalname, user, validateOnly: true });
  }

  // @body: pickFields=ASSET_FIELDS
  @RequirePermissions('asset:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  // @body: pickFields=ASSET_FIELDS
  @RequirePermissions('asset:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.update(id, body, projectId);
  }

  @RequirePermissions('asset:edit')
  @Delete(':id')
  remove(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.remove(id, projectId);
  }
}