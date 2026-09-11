import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ProcurementTemplateService } from './procurement-template.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('procurement-templates')
export class ProcurementTemplateController {
  constructor(private service: ProcurementTemplateService) {}

  @RequirePermissions('template:view')
  @Get()
  findAll(@ProjectId() projectId: string) {
    return this.service.findAll(projectId);
  }

  @RequirePermissions('template:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  @RequirePermissions('template:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('template:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.update(id, body, projectId);
  }

  @RequirePermissions('template:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
