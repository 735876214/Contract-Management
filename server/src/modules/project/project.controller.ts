import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ProjectService } from './project.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser } from '../../common/decorators/user.decorator';

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
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('project:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.projectService.findOne(id);
  }

  @RequirePermissions('project:edit')
  @Post()
  create(@Body() body: any) {
    return this.projectService.create(body);
  }

  /** 上传导入数据（需求 3.4） */
  @RequirePermissions('project:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  import(@UploadedFile() file: any) {
    if (!file) return { created: 0, errors: ['未上传文件'] };
    return this.projectService.importProjects(file.buffer);
  }

  @RequirePermissions('project:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.projectService.update(id, body);
  }

  @RequirePermissions('project:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.projectService.remove(id);
  }

  @RequirePermissions('project:view')
  @Get(':id/members')
  members(@Param('id') id: string) {
    return this.projectService.members(id);
  }

  @RequirePermissions('project:edit')
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() body: { userId: string; roleCode: string }) {
    return this.projectService.addMember(id, body.userId, body.roleCode);
  }

  @RequirePermissions('project:edit')
  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.projectService.removeMember(id, userId);
  }
}
