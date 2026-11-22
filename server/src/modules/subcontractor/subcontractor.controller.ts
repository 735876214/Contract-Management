import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { SubcontractorService } from './subcontractor.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';
import { IMPORT_UPLOAD_OPTIONS } from '../../common/utils/upload-rules';
import { sendFile } from '../../common/http/download';
import { noFileImportResult, noFileImportResultLegacy } from '../../common/utils/import-result';

/**
 * 分包商库（基础信息管理 → 分包商库）。
 * 权限：subcontractor:view / subcontractor:edit；options 对收领单/合同/台账的编辑者开放。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('subcontractors')
export class SubcontractorController {
  constructor(private subcontractorService: SubcontractorService) {}

  @RequirePermissions('subcontractor:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.subcontractorService.findAll(query, projectId);
  }

  @RequirePermissions('subcontractor:view', 'receipt:edit', 'contract:edit', 'labor:edit')
  @Get('options')
  options(@ProjectId() projectId: string, @Query('keyword') keyword?: string) {
    return this.subcontractorService.options(projectId, keyword);
  }

  @RequirePermissions('subcontractor:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.subcontractorService.export(projectId);
    sendFile(res, 'subcontractors.xlsx', buffer, 'xlsx');
  }

  /** 下载填写模板（须声明在 :id 通配路由之前） */
  @RequirePermissions('subcontractor:view')
  @Get('template')
  async template(@Res() res: Response) {
    const { buffer, filename } = await this.subcontractorService.template();
    sendFile(res, filename, buffer, 'xlsx');
  }

  @RequirePermissions('subcontractor:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.subcontractorService.findOne(id);
  }

  // @body: pickFields=SUBCONTRACTOR_FIELDS
  @RequirePermissions('subcontractor:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.subcontractorService.create(body, projectId);
  }

  // @body: pickFields=SUBCONTRACTOR_FIELDS
  @RequirePermissions('subcontractor:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.subcontractorService.update(id, body);
  }

  @RequirePermissions('subcontractor:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.subcontractorService.remove(id);
  }

  @RequirePermissions('subcontractor:edit')
  @Post(':id/toggle')
  toggle(@Param('id') id: string) {
    return this.subcontractorService.toggle(id);
  }

  @RequirePermissions('subcontractor:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  import(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return noFileImportResultLegacy();
    return this.subcontractorService.import(file.buffer, projectId, { fileName: file?.originalname, user });
  }

  @RequirePermissions('subcontractor:edit')
  @Post('import/validate')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importValidate(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return noFileImportResult();
    return this.subcontractorService.import(file.buffer, projectId, { fileName: file?.originalname, user, validateOnly: true });
  }
}
