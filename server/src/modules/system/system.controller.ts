import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { SystemService } from './system.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('system')
export class SystemController {
  constructor(private service: SystemService) {}

  // ---------- 用户 ----------
  @RequirePermissions('system:user')
  @Get('users')
  users(@Query() query: any) {
    return this.service.users(query);
  }

  @RequirePermissions('system:user')
  @Post('users')
  createUser(@Body() body: any) {
    return this.service.createUser(body);
  }

  @RequirePermissions('system:user')
  @Put('users/:id')
  updateUser(@Param('id') id: string, @Body() body: any) {
    return this.service.updateUser(id, body);
  }

  @RequirePermissions('system:user')
  @Delete('users/:id')
  removeUser(@Param('id') id: string) {
    return this.service.removeUser(id);
  }

  @RequirePermissions('system:user')
  @Post('users/:id/reset-password')
  resetPassword(@Param('id') id: string, @Body() body: { password: string }) {
    return this.service.resetPassword(id, body.password);
  }

  // ---------- 角色 / 权限 ----------
  @RequirePermissions('system:user')
  @Get('roles')
  roles() {
    return this.service.roles();
  }

  @RequirePermissions('system:user')
  @Post('roles')
  createRole(@Body() body: any) {
    return this.service.createRole(body);
  }

  @RequirePermissions('system:user')
  @Put('roles/:id')
  updateRole(@Param('id') id: string, @Body() body: any) {
    return this.service.updateRole(id, body);
  }

  @RequirePermissions('system:user')
  @Delete('roles/:id')
  removeRole(@Param('id') id: string) {
    return this.service.removeRole(id);
  }

  @RequirePermissions('system:user')
  @Get('permissions')
  permissions() {
    return this.service.permissions();
  }

  // ---------- 部门 ----------
  @RequirePermissions('system:user')
  @Get('depts')
  depts() {
    return this.service.depts();
  }

  @RequirePermissions('system:user')
  @Post('depts')
  createDept(@Body() body: any) {
    return this.service.createDept(body);
  }

  @RequirePermissions('system:user')
  @Put('depts/:id')
  updateDept(@Param('id') id: string, @Body() body: any) {
    return this.service.updateDept(id, body);
  }

  @RequirePermissions('system:user')
  @Delete('depts/:id')
  removeDept(@Param('id') id: string) {
    return this.service.removeDept(id);
  }

  // ---------- 参数 ----------
  @RequirePermissions('system:config')
  @Get('params')
  params() {
    return this.service.params();
  }

  @RequirePermissions('system:config')
  @Put('params')
  saveParams(@Body() body: { key: string; value?: string }[]) {
    return this.service.saveParams(body);
  }

  // ---------- 日志 ----------
  @RequirePermissions('system:log')
  @Get('logs/operations')
  operationLogs(@Query() query: any) {
    return this.service.operationLogs(query);
  }

  @RequirePermissions('system:log')
  @Get('logs/logins')
  loginLogs(@Query() query: any) {
    return this.service.loginLogs(query);
  }
}
