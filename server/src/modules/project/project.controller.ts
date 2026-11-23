import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ProjectService } from './project.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser } from '../../common/decorators/user.decorator';
import { IMPORT_UPLOAD_OPTIONS } from '../../common/utils/upload-rules';
import { sendFile } from '../../common/http/download';
import { noFileImportResult, noFileImportResultLegacyNoUpdate } from '../../common/utils/import-result';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('projects')
export class ProjectController {
  constructor(private projectService: ProjectService) {}

  @RequirePermissions('project:view')
  @Get()
  findAll(@Query() query: any, @CurrentUser() user: JwtUser) {
    return this.projectService.findAll(query, user);
  }

  /** 下载填写模板（需求 3.3） */
  @RequirePermissions('project:view')
  @Get('template')
  async template(@Res() res: Response) {
    const { buffer, filename } = await this.projectService.template();
    sendFile(res, filename, buffer, 'xlsx');
  }

  @RequirePermissions('project:view')
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.projectService.findOne(id, user);
  }

  // @body: pickFields=PROJECT_FIELDS
  @RequirePermissions('project:edit')
  @Post()
  create(@Body() body: any) {
    return this.projectService.create(body);
  }

  /** 上传导入数据（需求 3.4） */
  @RequirePermissions('project:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  import(@UploadedFile() file: any, @CurrentUser() user: any) {
    if (!file) return noFileImportResultLegacyNoUpdate();
    return this.projectService.importProjects(file.buffer, { fileName: file?.originalname, user });
  }

  /** 上传前预校验（不写库） */
  @RequirePermissions('project:edit')
  @Post('import/validate')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importValidate(@UploadedFile() file: any, @CurrentUser() user: any) {
    if (!file) return noFileImportResult();
    return this.projectService.importProjects(file.buffer, { fileName: file?.originalname, user, validateOnly: true });
  }

  // @body: pickFields=PROJECT_FIELDS
  @RequirePermissions('project:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: JwtUser) {
    return this.projectService.update(id, body, user);
  }

  @RequirePermissions('project:edit')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.projectService.remove(id, user);
  }

  @RequirePermissions('project:view')
  @Get(':id/members')
  members(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.projectService.members(id, user);
  }

  // @body: typed=inline
  @RequirePermissions('project:edit')
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() body: { userId: string; roleCode: string }, @CurrentUser() user: JwtUser) {
    return this.projectService.addMember(id, body.userId, body.roleCode, user);
  }

  @RequirePermissions('project:edit')
  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') userId: string, @CurrentUser() user: JwtUser) {
    return this.projectService.removeMember(id, userId, user);
  }
}