import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PaymentProcedureService } from './payment-procedure.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';

/**
 * 付款手续（付款管理下的编制单据，业务口径 2026-10-16）。
 * 权限码复用付款管理的 `payment:view` / `payment:edit` —— 它是付款管理的一部分，
 * 同一批人管；新开一套权限码只会让角色配置多一项而无实际区分。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('payment-procedures')
export class PaymentProcedureController {
  constructor(private service: PaymentProcedureService) {}

  @RequirePermissions('payment:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('payment:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('payment:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.create(body, projectId, user);
  }

  @RequirePermissions('payment:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @RequirePermissions('payment:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
