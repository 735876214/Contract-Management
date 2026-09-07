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

  @Post(':id/read')
  read(@Param('id') id: string) {
    return this.service.read(id);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: JwtUser) {
    return this.service.readAll(user);
  }

  @Post('send')
  send(@Body() body: any) {
    return this.service.send(body);
  }
}
