import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ProcurementTemplateService } from './procurement-template.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

/**
 * 采购模板接口。业务 2026-10-17：模板**全项目通用**，不再按项目隔离；
 * 能力对齐合同模板（版本历史/回滚/标签/状态）。
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
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.service.create(body, user?.userId || user?.id);
  }

  @RequirePermissions('template:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  /** 版本历史（新→旧） */
  @RequirePermissions('template:view')
  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.service.versions(id);
  }

  /** 回滚：基于旧版本内容创建新版本 */
  @RequirePermissions('template:edit')
  @Post(':id/rollback')
  rollback(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.service.rollback(id, body?.versionId, user?.userId || user?.id);
  }

  @RequirePermissions('template:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.service.update(id, body, user?.userId || user?.id);
  }

  @RequirePermissions('template:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
