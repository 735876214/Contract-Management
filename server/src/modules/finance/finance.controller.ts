import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { FinanceService } from './finance.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('finance')
export class FinanceController {
  constructor(private service: FinanceService) {}

  // ==================== 合同资金参数 ====================

  @RequirePermissions('finance:view')
  @Get('contract-params/:contractId')
  contractParams(@Param('contractId') contractId: string, @ProjectId() projectId: string) {
    return this.service.contractParams(contractId, projectId);
  }

  @RequirePermissions('finance:edit')
  @Put('contract-params/:contractId')
  updateContractParams(@Param('contractId') contractId: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.updateContractParams(contractId, body, projectId);
  }

  // ==================== 保理费用台账 ====================

  @RequirePermissions('finance:view')
  @Get('factoring-costs')
  listFactoring(@Query('contractId') contractId: string | undefined, @Query() query: any, @ProjectId() projectId: string) {
    return this.service.listFactoring(contractId, query, projectId);
  }

  @RequirePermissions('finance:view')
  @Get('factoring-costs/export')
  async exportFactoring(@Query('contractId') contractId: string | undefined, @Res() res: Response, @ProjectId() projectId: string) {
    const { buffer, filename } = await this.service.exportFactoring(contractId, projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  // @body: pickFields=FACTORING_FIELDS (via factoringPayload)
  @RequirePermissions('finance:edit')
  @Post('factoring-costs')
  createFactoring(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createFactoring(body, projectId);
  }

  // @body: pickFields=FACTORING_FIELDS (via factoringPayload)
  @RequirePermissions('finance:edit')
  @Put('factoring-costs/:id')
  updateFactoring(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.updateFactoring(id, body, projectId);
  }

  @RequirePermissions('finance:edit')
  @Delete('factoring-costs/:id')
  removeFactoring(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.removeFactoring(id, projectId);
  }

  // ==================== 逾期利息台账（应付款项 + 付款流水） ====================

  @RequirePermissions('finance:view')
  @Get('payment-modes')
  paymentModes() {
    return this.service.paymentModes();
  }

  @RequirePermissions('finance:view')
  @Get('overdue-interests')
  listOverdue(@Query('contractId') contractId: string | undefined, @Query() query: any, @ProjectId() projectId: string) {
    return this.service.listOverdue(contractId, query, projectId);
  }

  @RequirePermissions('finance:view')
  @Get('overdue-interests/export')
  async exportOverdue(@Query('contractId') contractId: string | undefined, @Query() query: any, @Res() res: Response, @ProjectId() projectId: string) {
    const { buffer, filename } = await this.service.exportOverdue(contractId, query, projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  /** 保存前预览（编辑器里算派生列，与保存后同一套引擎） */
  @RequirePermissions('finance:view')
  @Post('overdue-interests/preview')
  previewOverdue(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.previewOverdue(body, projectId);
  }

  @RequirePermissions('finance:edit')
  @Post('overdue-interests/generate')
  generateOverdue(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.generateOverdueRows(body.contractId, body.settlementMonth, Number(body.materialAmount), projectId);
  }

  @RequirePermissions('finance:edit')
  @Post('overdue-interests')
  createOverdue(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createOverdue(body, projectId);
  }

  // @body: pickFields=PAYABLE_FIELDS
  @RequirePermissions('finance:edit')
  @Put('overdue-interests/:id')
  updateOverdue(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.updateOverdue(id, body, projectId);
  }

  @RequirePermissions('finance:edit')
  @Delete('overdue-interests/:id')
  removeOverdue(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.removeOverdue(id, projectId);
  }

  // ---- 付款流水（子表） ----

  @RequirePermissions('finance:view')
  @Get('overdue-payments')
  listOverduePayments(@Query('contractId') contractId: string, @ProjectId() projectId: string) {
    return this.service.listOverduePayments(contractId, projectId);
  }

  @RequirePermissions('finance:edit')
  @Post('overdue-payments')
  createOverduePayment(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createOverduePayment(body, projectId);
  }

  // @body: pickFields=PAYMENT_FIELDS
  @RequirePermissions('finance:edit')
  @Put('overdue-payments/:id')
  updateOverduePayment(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.updateOverduePayment(id, body, projectId);
  }

  @RequirePermissions('finance:edit')
  @Delete('overdue-payments/:id')
  removeOverduePayment(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.removeOverduePayment(id, projectId);
  }
}
