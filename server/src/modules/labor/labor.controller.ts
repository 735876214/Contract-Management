import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { LaborService } from './labor.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';

/** 劳务管理 · 分包授权台账（附件需求 2026-10-17 新增模块） */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('labor/auth-ledger')
export class LaborController {
  constructor(private service: LaborService) {}

  @RequirePermissions('labor:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('labor:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('labor:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.create(body, projectId, user);
  }

  @RequirePermissions('labor:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @RequirePermissions('labor:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
