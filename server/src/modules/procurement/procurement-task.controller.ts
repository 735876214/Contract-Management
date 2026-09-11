import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ProcurementTaskService } from './procurement-task.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

/** 采购任务（批次二 · 任务 2.1 采购发起 + 工作流状态管理） */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('procurement-tasks')
export class ProcurementTaskController {
  constructor(private service: ProcurementTaskService) {}

  @RequirePermissions('contract:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('contract:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  /** 总采购清单明细（任务 2.2；frozen=true 表示已发布冻结） */
  @RequirePermissions('contract:view')
  @Get(':id/total-list')
  totalList(@Param('id') id: string) {
    return this.service.totalList(id);
  }

  /** 框架协议事前说明（任务 3.1；仅 FRAMEWORK 类型，状态由阶段推导：编辑中/已完成） */
  @RequirePermissions('contract:view')
  @Get(':id/framework-explanation')
  frameworkExplanation(@Param('id') id: string) {
    return this.service.frameworkExplanation(id);
  }

  /** 保存框架协议事前说明（发布后仍可重新编辑） */
  @RequirePermissions('contract:edit')
  @Put(':id/framework-explanation')
  saveFrameworkExplanation(@Param('id') id: string, @Body() body: any) {
    return this.service.saveFrameworkExplanation(id, body);
  }

  /** 保存总采购清单（全量替换；含基础库/字典/控制价校验与单位同步） */
  @RequirePermissions('contract:edit')
  @Put(':id/total-list')
  saveTotalList(@Param('id') id: string, @Body() body: any) {
    return this.service.saveTotalList(id, body?.items ?? []);
  }

  @RequirePermissions('contract:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  @RequirePermissions('contract:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  /** 发布当前阶段子任务，状态自动流转 */
  @RequirePermissions('contract:edit')
  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  /** 合同阶段状态同步（生成合同后由合同模块回调） */
  @RequirePermissions('contract:edit')
  @Post(':id/sync-contract-status')
  syncContractStatus(@Param('id') id: string) {
    return this.service.syncContractStatus(id);
  }

  @RequirePermissions('contract:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
