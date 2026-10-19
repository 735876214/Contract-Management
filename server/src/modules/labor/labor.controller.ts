import {
  Body, Controller, Delete, Get, Header, Param, Post, Put, Query, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { LaborService } from './labor.service';
import { StorageService } from '../../common/services/storage.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';
import { renderSubcontractorLetter, letterFileName } from './labor-letter';

/**
 * 劳务管理 · 分包授权台账（原「分包商库」并入，附件需求 2026-10-17）。
 * 功能 = 原分包商库全部能力（委托书预览/导出 PDF、四类图片、关联分包合同）+ 台账 Excel 导出。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('labor/auth-ledger')
export class LaborController {
  constructor(
    private service: LaborService,
    private storage: StorageService,
  ) {}

  @RequirePermissions('labor:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  /** 收领单下拉数据源（供应单位/领用单位 - 分包商；原分包商库 options） */
  @RequirePermissions('labor:view')
  @Get('options')
  options(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.options(query, projectId);
  }

  /** 分包材料员授权信息表.xlsx（图片内嵌单元格；归档「11.分包授权台账」的 Excel 源） */
  @RequirePermissions('labor:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const { exportLaborAuthWorkbook } = await import('./labor-excel');
    const buffer = await exportLaborAuthWorkbook(this.service['prisma'], projectId, this.storage);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent('分包材料员授权信息表.xlsx')}`);
    res.end(buffer);
  }

  @RequirePermissions('labor:view')
  @Get(':id')
  findOne(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.findOne(id, projectId);
  }

  /** 授权委托书打印就绪 HTML（iframe 预览） */
  @RequirePermissions('labor:view')
  @Get(':id/letter')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async letter(@Param('id') id: string, @ProjectId() projectId: string) {
    const row: any = await this.service.findOne(id, projectId);
    return renderSubcontractorLetter(row);
  }

  /** 附件要求文件名：分包材料员授权委托书_{分包商名称}_{日期}.pdf */
  @RequirePermissions('labor:view')
  @Get(':id/letter-filename')
  async letterFileName(@Param('id') id: string) {
    const row: any = await this.service.findOne(id);
    return { fileName: letterFileName(row.subcontractorName) };
  }

  @RequirePermissions('labor:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.create(body, projectId, user);
  }

  /** 授权委托书实时预览（未落库前按表单值渲染） */
  @RequirePermissions('labor:view')
  @Post('preview')
  @Header('Content-Type', 'text/html; charset=utf-8')
  preview(@Body() body: any) {
    return renderSubcontractorLetter(body || {});
  }

  /** 导出 PDF 版委托书 → 保存已填写信息并落库，状态置为「编辑中」 */
  @RequirePermissions('labor:edit')
  @Post('export-mark')
  exportMark(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.exportMark(body, projectId, user);
  }

  @RequirePermissions('labor:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.update(id, body, projectId);
  }

  /** 上传签字盖章版委托书 + 签字截图 → 状态置为「已完成」 */
  @RequirePermissions('labor:edit')
  @Post(':id/complete')
  complete(@Param('id') id: string, @Body() body: any) {
    return this.service.complete(id, body);
  }

  @RequirePermissions('labor:edit')
  @Delete(':id')
  remove(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.remove(id, projectId);
  }
}
