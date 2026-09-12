import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InspectionReportService } from './inspection-report.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

/** 考察报告（批次二 · 任务 3.7）：独立模块，不挂采购任务阶段链 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('procurement-inspection-reports')
export class InspectionReportController {
  constructor(private service: InspectionReportService) {}

  @RequirePermissions('contract:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('contract:view')
  @Get('all')
  listAll(@ProjectId() projectId: string) {
    return this.service.listAll(projectId);
  }

  @RequirePermissions('contract:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('contract:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(projectId, body);
  }

  @RequirePermissions('contract:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @RequirePermissions('contract:edit')
  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  @RequirePermissions('contract:edit')
  @Post(':id/unpublish')
  unpublish(@Param('id') id: string) {
    return this.service.unpublish(id);
  }

  @RequirePermissions('contract:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
