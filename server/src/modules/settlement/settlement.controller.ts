import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { SettlementService } from './settlement.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';
import { IMPORT_UPLOAD_OPTIONS } from '../../common/utils/upload-rules';

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
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importLedger(
    @UploadedFile() file: any,
    @ProjectId() projectId: string,
    @CurrentUser() user: any,
    @Query('mode') mode?: string,
  ) {
    if (!file) return { created: 0, errors: ['未上传文件'] };
    return this.service.importLedger(file.buffer, projectId, { fileName: file?.originalname, user, mode });
  }

  /** 上传前预校验（不写库） */
  @RequirePermissions('settlement:edit')
  @Post('ledger/import/validate')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  importLedgerValidate(
    @UploadedFile() file: any,
    @ProjectId() projectId: string,
    @CurrentUser() user: any,
    @Query('mode') mode?: string,
  ) {
    if (!file) return { total: 0, created: 0, updated: 0, errors: [{ row: 0, message: '未上传文件' }], valid: false };
    return this.service.importLedger(file.buffer, projectId, { fileName: file?.originalname, user, validateOnly: true, mode });
  }

  /** 一键自动生成/刷新结算台账：从结算单、收票登记、资金费用台账自动抓取 */
  @RequirePermissions('settlement:edit')
  @Post('ledger/refresh')
  refreshLedger(@ProjectId() projectId: string) {
    return this.service.refreshLedger(projectId);
  }

  /**
   * 预览「上一期」的待生成情况（结算单页顶部提示）：
   * 该期未挂结算单的收领单张数、还差几个合同 —— 有值就提示"去生成"。
   */
  @RequirePermissions('settlement:view')
  @Get('generate/preview')
  previewGenerate(@ProjectId() projectId: string, @Query('refDate') refDate?: string) {
    return this.service.previewPreviousPeriod(projectId, refDate);
  }

  /**
   * **生成本期（默认上一期）结算单**：抓取期间内未挂结算单的收领单，按物资合同各生成一张草稿结算单。
   * 幂等：已有结算单的合同会被跳过（`skipped` 计数）。
   */
  @RequirePermissions('settlement:edit')
  @Post('generate')
  generate(
    @ProjectId() projectId: string,
    @CurrentUser() user: any,
    @Body() body: { refDate?: string; contractId?: string } = {},
  ) {
    return this.service.generateForPeriod(projectId, {
      refDate: body?.refDate,
      contractId: body?.contractId,
      user,
    });
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
  ledgerOne(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.ledgerOne(id, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Post('ledger')
  createLedger(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.createLedger(body, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Put('ledger/:id')
  updateLedger(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.updateLedger(id, body, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Delete('ledger/:id')
  removeLedger(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.removeLedger(id, projectId);
  }

  @RequirePermissions('settlement:view')
  @Get(':id')
  findOne(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.findOne(id, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.update(id, body, projectId);
  }

  /** 任务 7：结算驳回 → 回填（纯状态回退） */
  @RequirePermissions('settlement:edit')
  @Post(':id/reject')
  reject(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.reject(id, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Delete(':id')
  remove(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.remove(id, projectId);
  }
}