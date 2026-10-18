import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { DocTemplateService } from './doc-template.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';

/**
 * 单据模板（基础信息管理 → 单据模板，业务口径 2026-10-17）：五类单据的 Excel 模板。
 * 权限复用合同模板的 `template:view` / `template:edit` —— 同一批人维护模板。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('doc-templates')
export class DocTemplateController {
  constructor(private service: DocTemplateService) {}

  @RequirePermissions('template:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  /**
   * 渲染**付款单**（付款手续 → Excel，业务 2026-10-17：生成路径 Word → Excel）。
   * `?templateId=` 可指定模板；不传则用启用中的「付款单」模板。
   */
  @RequirePermissions('template:view')
  @Get('render/payment-procedure/:procedureId')
  async renderPaymentProcedure(
    @Param('procedureId') procedureId: string,
    @Query('templateId') templateId: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.service.renderPaymentProcedure(procedureId, templateId || undefined);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('template:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('template:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.create(body, projectId, user);
  }

  @RequirePermissions('template:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @RequirePermissions('template:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
