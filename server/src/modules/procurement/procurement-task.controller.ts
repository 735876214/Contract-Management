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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ProcurementTaskService } from './procurement-task.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

/** 采购任务（批次二 · 任务 2.1 采购发起 + 工作流状态管理） */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('procurement-tasks')
export class ProcurementTaskController {
  constructor(private service: ProcurementTaskService) {}

  @RequirePermissions('contract:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('contract:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  /** 总采购清单明细（任务 2.2；frozen=true 表示已发布冻结） */
  @RequirePermissions('contract:view')
  @Get(':id/total-list')
  totalList(@Param('id') id: string) {
    return this.service.totalList(id);
  }

  /** 框架协议事前说明（任务 3.1；仅 FRAMEWORK 类型，状态由阶段推导：编辑中/已完成） */
  @RequirePermissions('contract:view')
  @Get(':id/framework-explanation')
  frameworkExplanation(@Param('id') id: string) {
    return this.service.frameworkExplanation(id);
  }

  /** 保存框架协议事前说明（发布后仍可重新编辑） */
  @RequirePermissions('contract:edit')
  @Put(':id/framework-explanation')
  saveFrameworkExplanation(@Param('id') id: string, @Body() body: any) {
    return this.service.saveFrameworkExplanation(id, body);
  }

  /** 采前会会议纪要（任务 3.2；仅单项采购且预计采购金额 ≥ 100 万时生成） */
  @RequirePermissions('contract:view')
  @Get(':id/pre-meeting-minutes')
  preMeetingMinutes(@Param('id') id: string) {
    return this.service.preMeetingMinutes(id);
  }

  /** 保存采前会会议纪要（发布后仍可重新编辑） */
  @RequirePermissions('contract:edit')
  @Put(':id/pre-meeting-minutes')
  savePreMeetingMinutes(@Param('id') id: string, @Body() body: any) {
    return this.service.savePreMeetingMinutes(id, body);
  }

  /** 采购公告（任务 3.3；仅单项采购，状态由阶段推导：编辑中/已完成） */
  @RequirePermissions('contract:view')
  @Get(':id/notice')
  notice(@Param('id') id: string) {
    return this.service.notice(id);
  }

  /** 保存采购公告（发布后仍可重新编辑） */
  @RequirePermissions('contract:edit')
  @Put(':id/notice')
  saveNotice(@Param('id') id: string, @Body() body: any) {
    return this.service.saveNotice(id, body);
  }

  /** 采购文件（任务 3.4；仅单项采购，入口条件为采购公告已完成） */
  @RequirePermissions('contract:view')
  @Get(':id/document')
  document(@Param('id') id: string) {
    return this.service.document(id);
  }

  /** 保存采购文件（发布后仍可重新编辑） */
  @RequirePermissions('contract:edit')
  @Put(':id/document')
  saveDocument(@Param('id') id: string, @Body() body: any) {
    return this.service.saveDocument(id, body);
  }

  /** 关联合同模板（补充四：采购文件「导出合同模板 / 预览合同模板」数据来源） */
  @RequirePermissions('contract:view')
  @Get(':id/contract-template')
  contractTemplate(@Param('id') id: string) {
    return this.service.contractTemplate(id);
  }

  /** 成交报告（任务 3.5；仅单项采购，入口条件为采购文件已完成） */
  @RequirePermissions('contract:view')
  @Get(':id/result-report')
  resultReport(@Param('id') id: string) {
    return this.service.resultReport(id);
  }

  /** 保存成交报告（发布后仍可重新编辑） */
  @RequirePermissions('contract:edit')
  @Put(':id/result-report')
  saveResultReport(@Param('id') id: string, @Body() body: any) {
    return this.service.saveResultReport(id, body);
  }

  /** 导入「响应单位情况汇总表」（Excel）；导入后自动重建四张表 */
  @RequirePermissions('contract:edit')
  @Post(':id/result-report/import')
  @UseInterceptors(FileInterceptor('file'))
  importResultReport(@Param('id') id: string, @UploadedFile() file: any) {
    return this.service.importResultReport(id, file?.buffer);
  }

  /** 下载「响应单位情况汇总表」导入模板 */
  @RequirePermissions('contract:view')
  @Get(':id/result-report/template')
  async resultReportTemplate(@Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.resultReportTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.end(buffer);
  }

  /** 采购价格对比表（任务 3.6；仅单项采购，入口条件为成交报告已完成） */
  @RequirePermissions('contract:view')
  @Get(':id/price-compare')
  priceCompare(@Param('id') id: string) {
    return this.service.priceCompare(id);
  }

  /** 保存采购价格对比表（发布后仍可重新编辑） */
  @RequirePermissions('contract:edit')
  @Put(':id/price-compare')
  savePriceCompare(@Param('id') id: string, @Body() body: any) {
    return this.service.savePriceCompare(id, body);
  }

  /** 保存总采购清单（全量替换；含基础库/字典/控制价校验与单位同步） */
  @RequirePermissions('contract:edit')
  @Put(':id/total-list')
  saveTotalList(@Param('id') id: string, @Body() body: any) {
    return this.service.saveTotalList(id, body?.items ?? []);
  }

  @RequirePermissions('contract:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  @RequirePermissions('contract:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  /** 发布当前阶段子任务，状态自动流转 */
  @RequirePermissions('contract:edit')
  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  /** 合同阶段状态同步（生成合同后由合同模块回调） */
  @RequirePermissions('contract:edit')
  @Post(':id/sync-contract-status')
  syncContractStatus(@Param('id') id: string) {
    return this.service.syncContractStatus(id);
  }

  @RequirePermissions('contract:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  /** 删除子模块记录并回退流程（问题二：仅流程最末端模块可删，删除后上一阶段恢复可编辑） */
  @RequirePermissions('contract:edit')
  @Delete(':id/modules/:moduleKey')
  deleteModule(@Param('id') id: string, @Param('moduleKey') moduleKey: string) {
    return this.service.deleteModule(id, moduleKey);
  }
}
