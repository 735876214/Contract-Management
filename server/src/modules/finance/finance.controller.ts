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

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('finance')
export class FinanceController {
  constructor(private service: FinanceService) {}

  // ==================== 合同资金参数 ====================

  @RequirePermissions('finance:view')
  @Get('contract-params/:contractId')
  contractParams(@Param('contractId') contractId: string) {
    return this.service.contractParams(contractId);
  }

  @RequirePermissions('finance:edit')
  @Put('contract-params/:contractId')
  updateContractParams(@Param('contractId') contractId: string, @Body() body: any) {
    return this.service.updateContractParams(contractId, body);
  }

  // ==================== 保理费用台账 ====================

  @RequirePermissions('finance:view')
  @Get('factoring-costs')
  listFactoring(@Query('contractId') contractId: string) {
    return this.service.listFactoring(contractId);
  }

  @RequirePermissions('finance:view')
  @Get('factoring-costs/export')
  async exportFactoring(@Query('contractId') contractId: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.exportFactoring(contractId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('finance:edit')
  @Post('factoring-costs')
  createFactoring(@Body() body: any) {
    return this.service.createFactoring(body);
  }

  @RequirePermissions('finance:edit')
  @Put('factoring-costs/:id')
  updateFactoring(@Param('id') id: string, @Body() body: any) {
    return this.service.updateFactoring(id, body);
  }

  @RequirePermissions('finance:edit')
  @Delete('factoring-costs/:id')
  removeFactoring(@Param('id') id: string) {
    return this.service.removeFactoring(id);
  }

  // ==================== 逾期利息台账 ====================

  @RequirePermissions('finance:view')
  @Get('overdue-interests')
  listOverdue(@Query('contractId') contractId: string, @Query() query: any) {
    return this.service.listOverdue(contractId, query);
  }

  @RequirePermissions('finance:view')
  @Get('overdue-interests/export')
  async exportOverdue(@Query('contractId') contractId: string, @Query() query: any, @Res() res: Response) {
    const { buffer, filename } = await this.service.exportOverdue(contractId, query);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('finance:edit')
  @Post('overdue-interests/generate')
  generateOverdue(@Body() body: any) {
    return this.service.generateOverdueRows(body.contractId, body.settlementMonth, Number(body.materialAmount));
  }

  @RequirePermissions('finance:edit')
  @Post('overdue-interests')
  createOverdue(@Body() body: any) {
    return this.service.createOverdue(body);
  }

  @RequirePermissions('finance:edit')
  @Put('overdue-interests/:id')
  updateOverdue(@Param('id') id: string, @Body() body: any) {
    return this.service.updateOverdue(id, body);
  }

  @RequirePermissions('finance:edit')
  @Delete('overdue-interests/:id')
  removeOverdue(@Param('id') id: string) {
    return this.service.removeOverdue(id);
  }
}
