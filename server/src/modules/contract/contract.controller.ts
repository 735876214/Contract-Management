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
import { ContractService } from './contract.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser, ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('contracts')
export class ContractController {
  constructor(private contractService: ContractService) {}

  @RequirePermissions('contract:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.contractService.findAll(query, projectId);
  }

  @RequirePermissions('contract:view', 'daily:edit', 'settlement:edit', 'payment:edit', 'invoice:edit', 'repayment:edit')
  @Get('options')
  options(@ProjectId() projectId: string, @Query('keyword') keyword?: string) {
    return this.contractService.options(projectId, keyword);
  }

  @RequirePermissions('contract:view', 'contract:edit')
  @Get('check-code')
  checkCode(@Query('code') code: string, @Query('excludeId') excludeId: string, @ProjectId() projectId: string) {
    return this.contractService.checkCode(code, projectId, excludeId);
  }

  @RequirePermissions('contract:view')
  @Get('next-code')
  nextCode(@Query() query: { typeCode?: string; subTypeCode?: string; projectId?: string; codeAbbr?: string }) {
    return this.contractService.nextCode(query);
  }

  /** 合同名称规则预览（需求 3.4） */
  @RequirePermissions('contract:view')
  @Get('name-preview')
  namePreview(@Query() query: any) {
    return this.contractService.namePreview(query);
  }

  /** 合同起草：当前用户草稿列表（需求 2.1，须声明在 :id 通配路由之前） */
  @RequirePermissions('contract:view')
  @Get('drafts')
  drafts(@CurrentUser() user: JwtUser, @ProjectId() projectId: string, @Query('status') status?: string) {
    return this.contractService.findDrafts(user.userId, projectId, status);
  }

  // ---------------- 合同起草：物料编码清单（Tab1） ----------------

  @RequirePermissions('contract:view')
  @Get(':id/material-pool')
  poolList(@Param('id') id: string) {
    return this.contractService.poolList(id);
  }

  @RequirePermissions('contract:edit')
  @Post(':id/material-pool')
  poolAdd(@Param('id') id: string, @Body() body: { materialIds: string[] }) {
    return this.contractService.poolAdd(id, body?.materialIds || []);
  }

  @RequirePermissions('contract:edit')
  @Delete(':id/material-pool/:poolId')
  poolRemove(@Param('id') id: string, @Param('poolId') poolId: string) {
    return this.contractService.poolRemove(id, poolId);
  }

  // ---------------- 合同起草：合同清单（Tab2） ----------------

  @RequirePermissions('contract:view')
  @Get(':id/draft-materials')
  draftList(@Param('id') id: string) {
    return this.contractService.draftList(id);
  }

  @RequirePermissions('contract:edit')
  @Post(':id/draft-materials')
  draftDerive(@Param('id') id: string, @Body() body: { materialBaseIds: string[] }) {
    return this.contractService.draftDerive(id, body?.materialBaseIds || []);
  }

  @RequirePermissions('contract:edit')
  @Put(':id/draft-materials')
  draftSave(@Param('id') id: string, @Body() body: { rows: any[] }) {
    return this.contractService.draftSave(id, body?.rows || []);
  }

  @RequirePermissions('contract:edit')
  @Delete(':id/draft-materials/:rowId')
  draftRemove(@Param('id') id: string, @Param('rowId') rowId: string) {
    return this.contractService.draftRemove(id, rowId);
  }

  // ---------------- 合同起草：发布与状态流转 ----------------

  @RequirePermissions('contract:edit')
  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.contractService.publish(id);
  }

  @RequirePermissions('contract:edit')
  @Put(':id/status')
  setStatus(@Param('id') id: string, @Body() body: { status: string }) {
    return this.contractService.setStatus(id, body?.status);
  }

  /** 删除草稿（仅本人创建且未提交，服务端二次校验） */
  @RequirePermissions('contract:view')
  @Delete('drafts/:id')
  removeDraft(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.contractService.removeDraft(id, user.userId);
  }

  @RequirePermissions('contract:view')
  @Get(':id/next-supplement-code')
  nextSupplementCode(@Param('id') id: string) {
    return this.contractService.nextSupplementCode(id);
  }

  /** 下载填写模板（需求 3.3，须声明在 :id 通配路由之前） */
  @RequirePermissions('contract:view')
  @Get('template')
  async template(@ProjectId() projectId: string, @Res() res: Response) {
    const { buffer, filename } = await this.contractService.template(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('contract:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.contractService.findOne(id);
  }

  @RequirePermissions('contract:view')
  @Get(':id/changes')
  changes(@Param('id') id: string) {
    return this.contractService.changes(id);
  }

  @RequirePermissions('contract:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.contractService.create(body, projectId, user);
  }

  @RequirePermissions('contract:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: JwtUser) {
    return this.contractService.update(id, body, user);
  }

  @RequirePermissions('contract:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.contractService.remove(id);
  }

  @RequirePermissions('contract:edit')
  @Put(':id/ext')
  saveExt(@Param('id') id: string, @Body() body: any) {
    return this.contractService.saveExt(id, body);
  }

  @RequirePermissions('contract:view')
  @Get(':id/ext')
  getExt(@Param('id') id: string) {
    return this.contractService.getExt(id);
  }

  @RequirePermissions('contract:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  import(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    if (!file) return { created: 0, errors: ['未上传文件'] };
    return this.contractService.import(file.buffer, projectId, user);
  }

}
