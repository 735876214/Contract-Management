import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser, JwtUser } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('approvals')
export class ApprovalController {
  constructor(private service: ApprovalService) {}

  @Get('todo')
  todo(@Query() query: any, @CurrentUser() user: JwtUser) {
    return this.service.todo(query, user);
  }

  @Get('done')
  done(@Query() query: any, @CurrentUser() user: JwtUser) {
    return this.service.done(query, user);
  }

  @Get('mine')
  mine(@Query() query: any, @CurrentUser() user: JwtUser) {
    return this.service.mine(query, user);
  }

  @Post(':id/approve')
  handle(@Param('id') id: string, @Body() body: { action: string; comment?: string }, @CurrentUser() user: JwtUser) {
    return this.service.handle(id, body.action, body.comment, user);
  }

  @Get('flows')
  flows(@Query() query: any) {
    return this.service.flows(query);
  }

  @Post('flows')
  createFlow(@Body() body: any) {
    return this.service.createFlow(body);
  }

  @Put('flows/:id')
  updateFlow(@Param('id') id: string, @Body() body: any) {
    return this.service.updateFlow(id, body);
  }

  @Delete('flows/:id')
  removeFlow(@Param('id') id: string) {
    return this.service.removeFlow(id);
  }
}
