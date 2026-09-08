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

  @RequirePermissions('material:edit')
  @Post('materials/import')
  @UseInterceptors(FileInterceptor('file'))
  importBases(@UploadedFile() file: any) {
    if (!file) return { created: 0, updated: 0, errors: ['未上传文件'] };
    return this.service.importBases(file.buffer);
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
  importRows(@Query('contractId') contractId: string, @UploadedFile() file: any) {
    if (!file) return { created: 0, updated: 0, errors: ['未上传文件'] };
    return this.service.importRows(contractId, file.buffer);
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
