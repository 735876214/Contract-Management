import { Body, Controller, Delete, Get, Header, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { SubcontractorService } from './subcontractor.service';
import { renderSubcontractorLetter, letterFileName } from './subcontractor-letter';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, ProjectId } from '../../common/decorators/user.decorator';

/**
 * 分包商库接口（基础信息管理 → 分包商库）
 * 权限：subcontractor:view / subcontractor:edit
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('subcontractors')
export class SubcontractorController {
  constructor(private service: SubcontractorService) {}

  @RequirePermissions('subcontractor:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  /** 收领单下拉数据源（编辑中 + 已完成），供供应单位/领用单位「分包商」Tab 使用 */
  @RequirePermissions('subcontractor:view')
  @Get('options')
  options(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.options(query, projectId);
  }

  @RequirePermissions('subcontractor:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  /**
   * 授权委托书正文 HTML（打印就绪，前端 window.open 后调用浏览器打印另存 PDF）
   * 需求 2.1.5：按 CCCEC-SW-B40410 模板版式生成
   */
  @RequirePermissions('subcontractor:view')
  @Get(':id/letter')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async letter(@Param('id') id: string) {
    const row: any = await this.service.findOne(id);
    return renderSubcontractorLetter(row);
  }

  /** 附件要求文件名：分包材料员授权委托书_{分包商名称}_{日期}.pdf */
  @RequirePermissions('subcontractor:view')
  @Get(':id/letter-filename')
  async letterFileName(@Param('id') id: string) {
    const row: any = await this.service.findOne(id);
    return { fileName: letterFileName(row.subcontractorName) };
  }

  @RequirePermissions('subcontractor:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.create(body, projectId, user);
  }

  /**
   * 授权委托书实时预览（未落库前按表单值渲染）
   * 供「填写信息 → 预览 → 导出 PDF」流程使用
   */
  @RequirePermissions('subcontractor:view')
  @Post('preview')
  @Header('Content-Type', 'text/html; charset=utf-8')
  preview(@Body() body: any) {
    return renderSubcontractorLetter(body || {});
  }

  /**
   * 导出 PDF 版委托书 → 保存已填写信息并推送到分包商库，状态置为「编辑中」
   * 前端在调用导出后调用此接口落库
   */
  @RequirePermissions('subcontractor:edit')
  @Post('export-mark')
  exportMark(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.exportMark(body, projectId, user);
  }

  @RequirePermissions('subcontractor:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  /** 上传签字盖章版委托书 + 签字截图 → 状态置为「已完成」 */
  @RequirePermissions('subcontractor:edit')
  @Post(':id/complete')
  complete(@Param('id') id: string, @Body() body: any) {
    return this.service.complete(id, body);
  }

  @RequirePermissions('subcontractor:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
