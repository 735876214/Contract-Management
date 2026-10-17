import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CostService } from './cost.service';
import { LaborReceivingService } from './labor-receiving.service';
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
  constructor(
    private service: CostService,
    private laborReceiving: LaborReceivingService,
  ) {}

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

  // ---- 劳务队领用月度汇总（附件需求 2026-10-17 第二批） ----

  /** 分包商下拉 + 已有期间列表 */
  @RequirePermissions('cost:view')
  @Get('labor-receiving/options')
  laborReceivingOptions(@ProjectId() projectId: string) {
    return this.laborReceiving.options(projectId);
  }

  /** 合并读取：自动领用/单价 + 手填行 + 派生列 */
  @RequirePermissions('cost:view')
  @Get('labor-receiving/summary')
  laborReceivingSummary(@Query('subcontractorId') subcontractorId: string, @Query('period') period: string, @ProjectId() projectId: string) {
    return this.laborReceiving.summary(subcontractorId, period, projectId);
  }

  /** upsert 单行手填字段 */
  @RequirePermissions('cost:edit')
  @Post('labor-receiving')
  laborReceivingUpsert(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.laborReceiving.upsert(body, projectId, user);
  }

  /** 批量保存（导入/整批提交） */
  @RequirePermissions('cost:edit')
  @Post('labor-receiving/batch')
  laborReceivingBatch(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.laborReceiving.saveBatch(body?.rows ?? [], projectId, user);
  }

  /** 导出三 sheet 工作簿（图一盘点 / 图二月度汇总 / 图三节超分析） */
  @RequirePermissions('cost:view')
  @Get('labor-receiving/export')
  async laborReceivingExport(
    @Query('subcontractorId') subcontractorId: string,
    @Query('period') period: string,
    @ProjectId() projectId: string,
    @Res() res: Response,
  ) {
    const buf = await this.laborReceiving.exportWorkbook(subcontractorId, period, projectId);
    const auth = await this.laborReceiving['prisma'].laborAuthLedger.findUnique({
      where: { id: subcontractorId },
      select: { subcontractorName: true },
    });
    const name = `${auth?.subcontractorName ?? '分包单位'}-${period}-盘点领用表.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.end(buf);
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
