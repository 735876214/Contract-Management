import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CostService } from './cost.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';

/**
 * 成本管理（附件需求 2026-10-17 新增一级模块）：
 * 分包领用汇总（/cost/receiving）+ 降本创效主材盈亏分析（/cost/profit-loss）。
 * 两块都是结构化台账（无上传附件），归档时按分包商/账期分组导出 Excel。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('cost')
export class CostController {
  constructor(private service: CostService) {}

  // ---- 分包领用汇总 ----

  @RequirePermissions('cost:view')
  @Get('receiving')
  listReceiving(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.listReceiving(query, projectId);
  }

  @RequirePermissions('cost:view')
  @Get('receiving/:id')
  getReceiving(@Param('id') id: string) {
    return this.service.getReceiving(id);
  }

  @RequirePermissions('cost:edit')
  @Post('receiving')
  createReceiving(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.createReceiving(body, projectId, user);
  }

  @RequirePermissions('cost:edit')
  @Put('receiving/:id')
  updateReceiving(@Param('id') id: string, @Body() body: any) {
    return this.service.updateReceiving(id, body);
  }

  @RequirePermissions('cost:edit')
  @Delete('receiving/:id')
  removeReceiving(@Param('id') id: string) {
    return this.service.removeReceiving(id);
  }

  // ---- 盈亏分析 ----

  @RequirePermissions('cost:view')
  @Get('profit-loss')
  listProfitLoss(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.listProfitLoss(query, projectId);
  }

  @RequirePermissions('cost:view')
  @Get('profit-loss/:id')
  getProfitLoss(@Param('id') id: string) {
    return this.service.getProfitLoss(id);
  }

  @RequirePermissions('cost:edit')
  @Post('profit-loss')
  createProfitLoss(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.createProfitLoss(body, projectId, user);
  }

  @RequirePermissions('cost:edit')
  @Put('profit-loss/:id')
  updateProfitLoss(@Param('id') id: string, @Body() body: any) {
    return this.service.updateProfitLoss(id, body);
  }

  @RequirePermissions('cost:edit')
  @Delete('profit-loss/:id')
  removeProfitLoss(@Param('id') id: string) {
    return this.service.removeProfitLoss(id);
  }
}
