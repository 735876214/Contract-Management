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
import { OtherProjectService } from './other-project.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';
import { IMPORT_UPLOAD_OPTIONS } from '../../common/utils/upload-rules';
import { sendFile } from '../../common/http/download';
import { noFileImportResult, noFileImportResultLegacy } from '../../common/utils/import-result';

/**
 * 其他项目库（基础信息管理 → 其他项目库）。
 * 权限：other-project:view / other-project:edit；options 对收领单编辑者开放。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('other-projects')
export class OtherProjectController {
  constructor(private otherProjectService: OtherProjectService) {}

  @RequirePermissions('other-project:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.otherProjectService.findAll(query, projectId);
  }

  @RequirePermissions('other-project:view', 'receipt:edit')
  @Get('options')
  options(@ProjectId() projectId: string, @Query('keyword') keyword?: string) {
    return this.otherProjectService.options(projectId, keyword);
  }

  @RequirePermissions('other-project:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.otherProjectService.export(projectId);
    sendFile(res, 'other-projects.xlsx', buffer, 'xlsx');
  }

  /** 下载填写模板（须声明在 :id 通配路由之前） */
  @RequirePermissions('other-project:view')
  @Get('template')
  async template(@Res() res: Response) {
    const { buffer, filename } = await this.otherProjectService.template();
    sendFile(res, filename, buffer, 'xlsx');
  }

  @RequirePermissions('other-project:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.otherProjectService.findOne(id);
  }

  // @body: pickFields=OTHER_PROJECT_FIELDS
  @RequirePermissions('other-project:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.otherProjectService.create(body, projectId);
  }

  // @body: pickFields=OTHER_PROJECT_FIELDS
  @RequirePermissions('other-project:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.otherProjectService.update(id, body);
  }

  @RequirePermissions('other-project:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.otherProjectService.remove(id);
  }

  @RequirePermissions('other-project:edit')
  @Post(':id/toggle')
  toggle(@Param('id') id: string) {
    return this.otherProjectService.toggle(id);
  }

  @RequirePermissions('other-project:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  import(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return noFileImportResultLegacy();
    return this.otherProjectService.import(file.buffer, projectId, { fileName: file?.originalname, user });
  }

  @RequirePermissions('other-project:edit')
  @Post('import/validate')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importValidate(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return noFileImportResult();
    return this.otherProjectService.import(file.buffer, projectId, { fileName: file?.originalname, user, validateOnly: true });
  }
}
