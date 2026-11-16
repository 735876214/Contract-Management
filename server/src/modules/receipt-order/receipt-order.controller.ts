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

  /**
   * 供应单位数据源（4 类 Tab：供应商 / 其他项目 / 分包商 / 本项目）
   * 支持 keyword 在各 Tab 范围内搜索
   */
  @RequirePermissions('receipt:view')
  @Get('party-options')
  partyOptions(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.supplierOptions(projectId, query.keyword);
  }

  /**
   * 领用单位数据源（3 类 Tab：分包商 / 本项目 / 其他项目）
   */
  @RequirePermissions('receipt:view')
  @Get('receiving-unit-options')
  receivingUnitOptions(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.receivingUnitOptions(projectId, query.keyword);
  }

  /** 互锁：按分包商查询其关联的分包合同 */
  @RequirePermissions('receipt:view')
  @Get('subcontractor-contracts')
  subcontractorContracts(@Query('subcontractorId') subcontractorId: string, @ProjectId() projectId: string) {
    return this.service.subcontractorContracts(subcontractorId, projectId);
  }

  /** 供应单位=供应商时，物资合同下拉 = 该供应商在本项目的合同 */
  @RequirePermissions('receipt:view')
  @Get('supplier-contracts')
  supplierContracts(@Query('supplierId') supplierId: string, @ProjectId() projectId: string) {
    return this.service.supplierContracts(supplierId, projectId);
  }

  /** 领用单位=分包商时，带出该分包商在本项目领用过的所有材料（与分包单位领用汇总同源口径） */
  @RequirePermissions('receipt:view')
  @Get('subcontractor-materials')
  subcontractorMaterials(@Query('subcontractorId') subcontractorId: string, @ProjectId() projectId: string) {
    return this.service.subcontractorMaterials(subcontractorId, projectId);
  }

  @RequirePermissions('receipt:view')
  @Get(':id')
  findOne(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.findOne(id, projectId);
  }

  @RequirePermissions('receipt:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.create(body, projectId, user);
  }

  @RequirePermissions('receipt:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.update(id, body, projectId);
  }

  /** 推送 / 重新推送明细到总日报 */
  @RequirePermissions('receipt:edit')
  @Post(':id/push')
  push(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.repush(id, projectId);
  }

  @RequirePermissions('receipt:edit')
  @Delete(':id')
  remove(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.remove(id, projectId);
  }
}
