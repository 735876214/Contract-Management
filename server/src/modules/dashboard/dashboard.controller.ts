import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser, ProjectId } from '../../common/decorators/user.decorator';

/**
 * 工作台 / 统计报表。
 *
 * **权限（2026-11-19 数据流转审计 P1）**：菜单 `/dashboard`、`/statistics` 都挂了
 * `dashboard:view`，本控制器此前只有 `JwtAuthGuard`——任何项目的普通成员（哪怕只被授
 * `daily:view`）直接打 `/api/dashboard/*` 就能读到汇总的合同/结算/付款/发票金额、
 * 到期提醒与资金预警，菜单权限形同虚设。这里按「类级兜底 + 方法级放开」收口：
 * 类上统一要求 `dashboard:view`，确需放开的方法用 `@RequirePermissions()`（空码表 =
 * `PermissionsGuard` 直接放行，见 permissions.guard.ts 的 `required.length === 0`）。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('dashboard:view')
@Controller('dashboard')
export class DashboardController {
  constructor(private service: DashboardService) {}

  @Get('overview')
  overview(@ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.service.overview(projectId, user);
  }

  @Get('trend')
  trend(@ProjectId() projectId: string) {
    return this.service.trend(projectId);
  }

  @Get('contract-type')
  contractType(@ProjectId() projectId: string) {
    return this.service.contractType(projectId);
  }

  @Get('invoice-stats')
  invoiceStats(@ProjectId() projectId: string) {
    return this.service.invoiceStats(projectId);
  }

  @Get('reminders')
  reminders(@ProjectId() projectId: string, @CurrentUser() user: JwtUser, @Query() _query: any) {
    return this.service.reminders(projectId, user);
  }

  /**
   * 我的待办（业务口径 2026-10-16）：按模块分类聚合，0 条的分类也返回（前端 Tab 常驻）。
   *
   * 刻意**不**要求 `dashboard:view`：待办只回当前登录人自己有权处理的条目
   * （`TODO_CATEGORIES.permission` 逐类过滤），是「我的任务」而非统计报表；
   * 要求看板权限会把只做业务、不看统计的人挡在自己的待办外。
   */
  @RequirePermissions()
  @Get('todos')
  todos(@ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.service.todos(projectId, user);
  }
}
