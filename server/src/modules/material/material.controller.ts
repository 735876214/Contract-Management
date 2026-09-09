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
import { MaterialService } from './material.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller()
export class MaterialController {
  constructor(private service: MaterialService) {}

  // ==================== 物资基础库 ====================

  @RequirePermissions('material:view')
  @Get('materials')
  findBases(@Query() query: any) {
    return this.service.findBases(query);
  }

  @RequirePermissions('material:view')
  @Get('materials/options')
  baseOptions(@Query('keyword') keyword?: string) {
    return this.service.baseOptions(keyword);
  }

  @RequirePermissions('material:view')
  @Get('materials/export')
  async exportBases(@Res() res: Response) {
    const buffer = await this.service.exportBases();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=material-base.xlsx');
    res.end(buffer);
  }

  /** 下载填写模板（需求 3.3） */
  @RequirePermissions('material:view')
  @Get('materials/template')
  async templateBases(@Res() res: Response) {
    const { buffer, filename } = await this.service.templateBases();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('material:edit')
  @Post('materials/import')
  @UseInterceptors(FileInterceptor('file'))
  importBases(@UploadedFile() file: any, @CurrentUser() user: any) {
    if (!file) return { created: 0, updated: 0, errors: ['未上传文件'] };
    return this.service.importBases(file.buffer, { fileName: file?.originalname, user });
  }

  @RequirePermissions('material:edit')
  @Post('materials')
  createBase(@Body() body: any) {
    return this.service.createBase(body);
  }

  @RequirePermissions('material:edit')
  @Put('materials/:id')
  updateBase(@Param('id') id: string, @Body() body: any) {
    return this.service.updateBase(id, body);
  }

  @RequirePermissions('material:edit')
  @Post('materials/:id/toggle')
  toggleBase(@Param('id') id: string) {
    return this.service.toggleBase(id);
  }

  @RequirePermissions('material:edit')
  @Delete('materials/:id')
  removeBase(@Param('id') id: string) {
    return this.service.removeBase(id);
  }

  // ==================== 合同物资清单 ====================

  @RequirePermissions('material:view')
  @Get('contract-materials')
  findRows(@Query('contractId') contractId: string) {
    return this.service.findRows(contractId);
  }

  /** 下载填写模板（需求 3.3） */
  @RequirePermissions('material:view')
  @Get('contract-materials/template')
  async templateRows(@Res() res: Response) {
    const { buffer, filename } = await this.service.templateRows();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  /** 派生清单（需求 2.3）：从物资基础库按所选物资重新生成，序号从 1 开始 */
  @RequirePermissions('material:edit')
  @Post('contract-materials/derive')
  derive(@Body() body: any) {
    return this.service.derive(String(body?.contractId || ''), Array.isArray(body?.materialIds) ? body.materialIds : []);
  }

  @RequirePermissions('material:view')
  @Get('contract-materials/export')
  async exportRows(@Query('contractId') contractId: string, @Query('format') format: string, @Res() res: Response) {
    const { buffer, filename, mime } = await this.service.exportRows(
      contractId,
      format === 'csv' ? 'csv' : 'xlsx',
    );
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('material:edit')
  @Post('contract-materials/import')
  @UseInterceptors(FileInterceptor('file'))
  importRows(@Query('contractId') contractId: string, @UploadedFile() file: any, @CurrentUser() user: any) {
    if (!file) return { created: 0, updated: 0, errors: ['未上传文件'] };
    return this.service.importRows(contractId, file.buffer, { fileName: file?.originalname, user });
  }

  @RequirePermissions('material:edit')
  @Post('contract-materials')
  createRow(@Body() body: any) {
    return this.service.createRow(body);
  }

  @RequirePermissions('material:edit')
  @Put('contract-materials/sort')
  sortRows(@Body() body: any) {
    return this.service.sortRows(body?.items);
  }

  @RequirePermissions('material:edit')
  @Put('contract-materials/:id')
  updateRow(@Param('id') id: string, @Body() body: any) {
    return this.service.updateRow(id, body);
  }

  @RequirePermissions('material:edit')
  @Delete('contract-materials/:id')
  removeRow(@Param('id') id: string) {
    return this.service.removeRow(id);
  }
}
