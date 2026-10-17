import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CostService } from './cost.service';
import { LaborReceivingService } from './labor-receiving.service';
import { MonthlyProfitLossService } from './monthly-profit-loss.service';
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
    private monthlyProfitLoss: MonthlyProfitLossService,
  ) {}

  // ---- 分包单位领用单据（附件需求 2026-10-17 第二批单据化） ----

  /** 分包单位下拉 */
  @RequirePermissions('cost:view')
  @Get('labor-receiving/options')
  laborReceivingOptions(@ProjectId() projectId: string) {
    return this.laborReceiving.options(projectId);
  }

  /** 单据列表 */
  @RequirePermissions('cost:view')
  @Get('labor-receiving/docs')
  laborReceivingDocs(@Query() query: any, @ProjectId() projectId: string) {
    return this.laborReceiving.listDocs(query, projectId);
  }

  /** 新建单据（选分包单位 + 结算期） */
  @RequirePermissions('cost:edit')
  @Post('labor-receiving/docs')
  laborReceivingCreateDoc(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.laborReceiving.createDoc(body, projectId, user);
  }

  /** 单据详情（头 + 明细，含自动聚合列） */
  @RequirePermissions('cost:view')
  @Get('labor-receiving/docs/:id')
  laborReceivingDocDetail(@Param('id') id: string) {
    return this.laborReceiving.docDetail(id);
  }

  /** 更新单据（头字段 + 明细批量） */
  @RequirePermissions('cost:edit')
  @Put('labor-receiving/docs/:id')
  laborReceivingUpdateDoc(@Param('id') id: string, @Body() body: any) {
    return this.laborReceiving.updateDoc(id, body);
  }

  @RequirePermissions('cost:edit')
  @Delete('labor-receiving/docs/:id')
  laborReceivingRemoveDoc(@Param('id') id: string) {
    return this.laborReceiving.removeDoc(id);
  }

  /** 导出三 sheet 工作簿（盘点 / 月度汇总 / 节超分析，按表样） */
  @RequirePermissions('cost:view')
  @Get('labor-receiving/docs/:id/export')
  async laborReceivingExport(@Param('id') id: string, @Res() res: Response) {
    const buf = await this.laborReceiving.exportWorkbook(id);
    const doc = await this.laborReceiving['prisma'].laborReceivingDoc.findUnique({
      where: { id },
      select: { docNo: true, subcontractorName: true, period: true },
    });
    const name = `${doc?.subcontractorName ?? '分包单位'}-${doc?.period ?? ''}-盘点领用表.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.end(buf);
  }

  // ---- 月度盈亏分析（附件需求 2026-10-17 第三批；替换原手工台账 ProfitLossAnalysis） ----

  @RequirePermissions('cost:view')
  @Get('monthly-profit-loss')
  listMonthlyProfitLoss(@Query() query: any, @ProjectId() projectId: string) {
    return this.monthlyProfitLoss.list(query, projectId);
  }

  @RequirePermissions('cost:view')
  @Get('monthly-profit-loss/:id')
  getMonthlyProfitLoss(@Param('id') id: string) {
    return this.monthlyProfitLoss.detail(id);
  }

  /** 新建（选结算期 → 生成当期节超快照明细） */
  @RequirePermissions('cost:edit')
  @Post('monthly-profit-loss')
  createMonthlyProfitLoss(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.monthlyProfitLoss.create(body, projectId, user);
  }

  @RequirePermissions('cost:edit')
  @Put('monthly-profit-loss/:id')
  updateMonthlyProfitLoss(@Param('id') id: string, @Body() body: any) {
    return this.monthlyProfitLoss.update(id, body);
  }

  @RequirePermissions('cost:edit')
  @Delete('monthly-profit-loss/:id')
  removeMonthlyProfitLoss(@Param('id') id: string) {
    return this.monthlyProfitLoss.remove(id);
  }

  /** 重新抓取：删明细重生成快照（手填项按 分包单位+材料+规格 回填） */
  @RequirePermissions('cost:edit')
  @Post('monthly-profit-loss/:id/re-snapshot')
  reSnapshotMonthlyProfitLoss(@Param('id') id: string) {
    return this.monthlyProfitLoss.reSnapshot(id);
  }

  /** 导出三 sheet xlsx（封面 / 明细表 / 汇总表） */
  @RequirePermissions('cost:view')
  @Get('monthly-profit-loss/:id/export')
  async exportMonthlyProfitLoss(@Param('id') id: string, @ProjectId() projectId: string, @Res() res: Response) {
    const buf = await this.monthlyProfitLoss.exportWorkbook(id, projectId);
    const rec = await this.monthlyProfitLoss['prisma'].monthlyProfitLoss.findUnique({
      where: { id },
      select: { period: true },
    });
    const name = `降本、创效、主材盈亏分析表-${rec?.period ?? id}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.end(buf);
  }
}
