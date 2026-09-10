import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReceiptOrderService } from './receipt-order.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, ProjectId } from '../../common/decorators/user.decorator';

/**
 * 收领单接口（日报管理 → 收领单）
 * 权限：receipt:view / receipt:edit（归属日报管理模块）
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('receipt-orders')
export class ReceiptOrderController {
  constructor(private service: ReceiptOrderService) {}

  @RequirePermissions('receipt:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  /** 生成收领单编号（新增时调用） */
  @RequirePermissions('receipt:view')
  @Get('next-no')
  nextNo(@ProjectId() projectId: string) {
    return this.service.nextOrderNo(projectId);
  }

  /** 选择物资合同后带出合同物资清单 */
  @RequirePermissions('receipt:view')
  @Get('contract-materials')
  contractMaterials(@Query('contractId') contractId: string) {
    return this.service.loadContractMaterials(contractId);
  }

  @RequirePermissions('receipt:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('receipt:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.create(body, projectId, user);
  }

  @RequirePermissions('receipt:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  /** 推送 / 重新推送明细到总日报 */
  @RequirePermissions('receipt:edit')
  @Post(':id/push')
  push(@Param('id') id: string) {
    return this.service.repush(id);
  }

  @RequirePermissions('receipt:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
