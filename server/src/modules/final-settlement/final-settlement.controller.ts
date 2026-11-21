import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { FinalSettlementService } from './final-settlement.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';

/**
 * 总结算单（结算及付款管理，业务口径 2026-10-16）。
 * 权限复用结算的 `settlement:view` / `settlement:edit` —— 它是结算域的单据，同一批人管。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('final-settlements')
export class FinalSettlementController {
  constructor(private service: FinalSettlementService) {}

  @RequirePermissions('settlement:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  /** 生成：抓取该合同全部（非草稿）月度结算 → 明细快照 + 合计；一个合同只允许一张 */
  // @body: typed=inline
  @RequirePermissions('settlement:edit')
  @Post('generate')
  generate(@Body() body: { contractId: string }, @ProjectId() projectId: string, @CurrentUser() user: any) {
    return this.service.generate(body?.contractId, projectId, user);
  }

  @RequirePermissions('settlement:view')
  @Get(':id/export')
  async export(
    @Param('id') id: string,
    @ProjectId() projectId: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.service.export(id, undefined, projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('settlement:view')
  @Get(':id')
  findOne(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.findOne(id, projectId);
  }

  // @body: pickFields=FIELDS
  @RequirePermissions('settlement:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.update(id, body, projectId);
  }

  /** 编辑明细（月份/金额）+ 审减金额：保存即重算合计（仅「待上传附件」状态可改） */
  @RequirePermissions('settlement:edit')
  @Put(':id/items')
  updateItems(@Param('id') id: string, @Body() body: any, @ProjectId() projectId: string) {
    return this.service.updateItems(id, body, projectId);
  }

  /** 上传附件 → 已结算 → 合同「已完已结」+ 付款比例切 100% */
  // @body: typed=inline
  @RequirePermissions('settlement:edit')
  @Post(':id/attach')
  attach(
    @Param('id') id: string,
    @Body() body: { url: string; fileName: string },
    @CurrentUser() user: any,
    @ProjectId() projectId: string,
  ) {
    return this.service.attach(id, body, user, projectId);
  }

  @RequirePermissions('settlement:edit')
  @Delete(':id')
  remove(@Param('id') id: string, @ProjectId() projectId: string) {
    return this.service.remove(id, projectId);
  }
}
