import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ProcurementTemplateService } from './procurement-template.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

/**
 * 采购模板接口。业务 2026-10-17：模板**全项目通用**，不再按项目隔离
 * （controller 不注入 @ProjectId；历史 projectId 列已弃用）。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('procurement-templates')
export class ProcurementTemplateController {
  constructor(private service: ProcurementTemplateService) {}

  @RequirePermissions('template:view')
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @RequirePermissions('template:edit')
  @Post()
  create(@Body() body: any) {
    return this.service.create(body);
  }

  @RequirePermissions('template:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('template:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @RequirePermissions('template:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
