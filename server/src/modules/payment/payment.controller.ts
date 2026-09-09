import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser, ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('payments')
export class PaymentController {
  constructor(private service: PaymentService) {}

  // ---------- 付款计划 ----------
  @RequirePermissions('payment:view')
  @Get('plans')
  findPlans(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findPlans(query, projectId);
  }

  @RequirePermissions('payment:edit')
  @Post('plans')
  createPlan(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createPlan(body, projectId);
  }

  @RequirePermissions('payment:edit')
  @Post('plans/generate')
  generatePlans(@Body() body: { contractId: string; ratios?: number[]; months?: number[] }, @ProjectId() projectId: string) {
    return this.service.generatePlans(body.contractId, projectId, body);
  }

  @RequirePermissions('payment:edit')
  @Put('plans/:id')
  updatePlan(@Param('id') id: string, @Body() body: any) {
    return this.service.updatePlan(id, body);
  }

  @RequirePermissions('payment:edit')
  @Delete('plans/:id')
  removePlan(@Param('id') id: string) {
    return this.service.removePlan(id);
  }

  // ---------- 付款申请 ----------
  @RequirePermissions('payment:view')
  @Get('applies')
  findApplies(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findApplies(query, projectId);
  }

  @RequirePermissions('payment:edit')
  @Post('applies')
  createApply(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createApply(body, projectId);
  }

  @RequirePermissions('payment:edit')
  @Put('applies/:id')
  updateApply(@Param('id') id: string, @Body() body: any) {
    return this.service.updateApply(id, body);
  }

  @RequirePermissions('payment:edit')
  @Delete('applies/:id')
  removeApply(@Param('id') id: string) {
    return this.service.removeApply(id);
  }

  // ---------- 付款执行 / 台账 ----------
  @RequirePermissions('payment:view')
  @Get('records')
  findRecords(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findRecords(query, projectId);
  }

  @RequirePermissions('payment:view')
  @Get('records/export')
  async exportRecords(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.service.exportRecords(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=payment-records.xlsx');
    res.end(buffer);
  }

  /** 下载填写模板（需求 3.3） */
  @RequirePermissions('payment:view')
  @Get('records/template')
  async templateRecords(@ProjectId() projectId: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.templateRecords(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  /** 上传导入数据（需求 3.4） */
  @RequirePermissions('payment:edit')
  @Post('records/import')
  @UseInterceptors(FileInterceptor('file'))
  importRecords(@UploadedFile() file: any, @ProjectId() projectId: string) {
    if (!file) return { created: 0, errors: ['未上传文件'] };
    return this.service.importRecords(file.buffer, projectId);
  }

  @RequirePermissions('payment:edit')
  @Post('records')
  createRecord(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createRecord(body, projectId);
  }

  @RequirePermissions('payment:edit')
  @Put('records/:id')
  updateRecord(@Param('id') id: string, @Body() body: any) {
    return this.service.updateRecord(id, body);
  }

  @RequirePermissions('payment:edit')
  @Delete('records/:id')
  removeRecord(@Param('id') id: string) {
    return this.service.removeRecord(id);
  }

  // ---------- 核销 & 逾期 ----------
  @RequirePermissions('payment:view')
  @Get('verifications')
  verifications(@ProjectId() projectId: string) {
    return this.service.verifications(projectId);
  }

  @RequirePermissions('payment:view')
  @Get('overdue')
  overdue(@ProjectId() projectId: string) {
    return this.service.overdue(projectId);
  }
}
