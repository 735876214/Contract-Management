import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, JwtUser } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private service: NotificationService) {}

  @Get()
  findAll(@Query() query: any, @CurrentUser() user: JwtUser) {
    return this.service.findAll(query, user);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: JwtUser) {
    return this.service.unreadCount(user);
  }

  /** 只能操作自己的通知（防跨用户标记已读/抑制他人提醒） */
  @Post(':id/read')
  read(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.service.read(id, user);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: JwtUser) {
    return this.service.readAll(user);
  }

  /**
   * 站内通知发送：**仅供内部服务使用**（导入任务完成/失败通知），
   * 不对前端开放——否则任何登录用户可向任意用户投递仿冒通知（钓鱼）。
   * 已从控制器移除；服务端路径 `NotificationService.send()` 保持不变。
   */
}
