import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
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

  /** 按用户权限过滤的数据集注册表（只含已实现条目） */
  @RequirePermissions('ai:view')
  @Get('datasets')
  datasets(@CurrentUser() user: JwtUser) {
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
}
