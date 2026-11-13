import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AnalyticsService, type AnalyticsReportInput } from './analytics.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser, ProjectId } from '../../../common/decorators/user.decorator';
import type { AiAnalyticsPlanInput } from '../intent/intent.types';

/**
 * AI 经营数据助手（`/api/ai/analytics`）。
 *
 * 读用 `ai:view`、写/生成用 `ai:use`；DELETE 记录（Phase 2）也用 `ai:use`。
 * Phase 1 只有两个端点：数据集注册表与规则意图预览。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('ai/analytics')
export class AnalyticsController {
  constructor(private service: AnalyticsService) {}

  /** 按用户权限过滤的数据集注册表（只含已实现条目）；`scope` 仅做取值校验，权限过滤不因 scope 收窄 */
  @RequirePermissions('ai:view')
  @Get('datasets')
  datasets(@Query('scope') scope: string | undefined, @CurrentUser() user: JwtUser) {
    const s = String(scope ?? '').trim();
    if (s && !['current', 'selected', 'all'].includes(s)) {
      throw new BadRequestException(`未知的 scope：${s}`);
    }
    return this.service.listDatasets(user);
  }

  /**
   * 自然语言/结构化选择 → 最终意图（规则路径）。
   * `projectId` 只用于 `scope=current`；跨项目按成员关系与 `dashboard:view` 收口。
   */
  @RequirePermissions('ai:use')
  @Post('plan')
  plan(@Body() body: AiAnalyticsPlanInput, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.service.plan(body || {}, projectId, user);
  }

  /** 确定性报告（Phase 2 不调模型）：成功即落库，返回 id 供历史/导出使用 */
  @RequirePermissions('ai:use')
  @Post('report')
  report(@Body() body: AnalyticsReportInput, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.service.report(body || {}, projectId, user);
  }

  /** 多 sheet 工作簿（不调模型、不扣配额）；可带 `reportId` 挂到已有报告记录 */
  @RequirePermissions('ai:use')
  @Post('workbook')
  workbook(
    @Body() body: AnalyticsReportInput & { reportId?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.workbook(body || {}, projectId, user);
  }

  /** 历史列表：默认本人全部（跨项目可见）；`projectId` 可选筛选；超管 `all=1` */
  @RequirePermissions('ai:view')
  @Get()
  history(@Query() query: any, @CurrentUser() user: JwtUser) {
    return this.service.list(user, query || {});
  }

  /** 记录详情（本人或超管；非创建人 404） */
  @RequirePermissions('ai:view')
  @Get(':id/export')
  async exportRecord(
    @Param('id') id: string,
    @Query('format') format: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    const isPdf = String(format || 'docx').toLowerCase() === 'pdf';
    const { buffer, fileName } = await this.service.exportRecord(id, format, user);
    res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="analytics.${isPdf ? 'pdf' : 'docx'}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(buffer);
  }

  /** 下载存档工作簿（只按记录 key 读取） */
  @RequirePermissions('ai:view')
  @Get(':id/workbook')
  async workbookFile(@Param('id') id: string, @CurrentUser() user: JwtUser, @Res() res: Response) {
    const { buffer, fileName } = await this.service.workbookFile(id, user);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="analytics.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(buffer);
  }

  @RequirePermissions('ai:view')
  @Get(':id')
  detail(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.detail(id, user);
  }

  /** 删除记录：只删 DB 行（文件留给存储审计） */
  @RequirePermissions('ai:use')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.remove(id, user);
  }
}
