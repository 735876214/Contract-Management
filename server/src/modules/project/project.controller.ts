import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
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
