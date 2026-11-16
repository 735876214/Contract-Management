import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TemplateService } from './template.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser, ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('templates')
export class TemplateController {
  constructor(private templateService: TemplateService) {}

  @RequirePermissions('template:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.templateService.findAll(query, projectId);
  }

  @RequirePermissions('template:view')
  @Get('guide/categories')
  guideCategories(@Query() query: any) {
    return this.templateService.guideCategories(query);
  }

  @RequirePermissions('template:view')
  @Get('clauses')
  clauses(@Query() query: any) {
    return this.templateService.clauses(query);
  }

  @RequirePermissions('template:edit')
  @Post('clauses')
  createClause(@Body() body: any, @CurrentUser() user: JwtUser) {
    return this.templateService.createClause(body, user);
  }

  @RequirePermissions('template:edit')
  @Put('clauses/:id')
  updateClause(@Param('id') id: string, @Body() body: any) {
    return this.templateService.updateClause(id, body);
  }

  @RequirePermissions('template:edit')
  @Delete('clauses/:id')
  removeClause(@Param('id') id: string) {
    return this.templateService.removeClause(id);
  }

  @RequirePermissions('template:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.templateService.findOne(id);
  }

  @RequirePermissions('template:view')
  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.templateService.versions(id);
  }

  @RequirePermissions('template:edit')
  @Post()
  create(@Body() body: any, @CurrentUser() user: JwtUser) {
    return this.templateService.create(body, user);
  }

  @RequirePermissions('template:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: JwtUser) {
    return this.templateService.update(id, body, user);
  }

  @RequirePermissions('template:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.templateService.remove(id);
  }

  @RequirePermissions('template:edit')
  @Post(':id/toggle')
  toggle(@Param('id') id: string) {
    return this.templateService.toggle(id);
  }

  @RequirePermissions('template:edit')
  @Post(':id/rollback')
  rollback(@Param('id') id: string, @Body() body: { targetId: string }, @CurrentUser() user: JwtUser) {
    return this.templateService.rollback(id, body.targetId, user);
  }

  @RequirePermissions('template:edit')
  @Post('guide/generate')
  generate(@Body() body: { templateId: string; contractId: string; manual?: any }, @ProjectId() projectId: string) {
    return this.templateService.generate(body, projectId);
  }
}
