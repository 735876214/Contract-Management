import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { SettlementService } from './settlement.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('settlements')
export class SettlementController {
  constructor(private service: SettlementService) {}

  @RequirePermissions('settlement:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('settlement:view')
  @Get('ledger')
  findLedger(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findLedger(query, projectId);
  }

  @RequirePermissions('settlement:view')
  @Get('ledger/export')
  async exportLedger(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.service.exportLedger(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=settlement-ledger.xlsx');
    res.end(buffer);
  }

  /** 下载填写模板（需求 3.3） */
  @RequirePermissions('settlement:view')
  @Get('ledger/template')
  async templateLedger(@ProjectId() projectId: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.templateLedger(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  /** 上传导入数据（需求 3.4） */
  @RequirePermissions('settlement:edit')
  @Post('ledger/import')
  @UseInterceptors(FileInterceptor('file'))
  importLedger(@UploadedFile() file: any, @ProjectId() projectId: string) {
    if (!file) return { created: 0, errors: ['未上传文件'] };
    return this.service.importLedger(file.buffer, projectId);
  }

  @RequirePermissions('settlement:view')
  @Get('compliance-sheet')
  async exportComplianceSheet(
    @Query('contractId') contractId: string,
    @Query('year') year: string,
    @Query('month') month: string,
    @ProjectId() projectId: string,
    @Res() res: Response,
  ) {
    const buffer = await this.service.exportComplianceSheet(contractId, projectId, Number(year), Number(month));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent('月度结算单合规性检查表.xlsx')}`);
    res.end(buffer);
  }

  @RequirePermissions('settlement:view')
  @Get('ledger/:id')
  ledgerOne(@Param('id') id: string) {
    return this.service.ledgerOne(id);
  }

  @RequirePermissions('settlement:edit')
  @Post('ledger')
  createLedger(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createLedger(body, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Put('ledger/:id')
  updateLedger(@Param('id') id: string, @Body() body: any) {
    return this.service.updateLedger(id, body);
  }

  @RequirePermissions('settlement:edit')
  @Delete('ledger/:id')
  removeLedger(@Param('id') id: string) {
    return this.service.removeLedger(id);
  }

  @RequirePermissions('settlement:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('settlement:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @RequirePermissions('settlement:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
