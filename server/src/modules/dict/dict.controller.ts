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
import { DictService } from './dict.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('dict')
export class DictController {
  constructor(private dictService: DictService) {}

  // ---------- 类型 ----------
  @RequirePermissions('dict:view', 'system:config')
  @Get('types')
  findTypes(@Query() query: any) {
    return this.dictService.findTypes(query);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Post('types')
  createType(@Body() body: any) {
    return this.dictService.createType(body);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Put('types/:id')
  updateType(@Param('id') id: string, @Body() body: any) {
    return this.dictService.updateType(id, body);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Delete('types/:id')
  removeType(@Param('id') id: string) {
    return this.dictService.removeType(id);
  }

  // ---------- 字典项 ----------
  @RequirePermissions('dict:view', 'system:config')
  @Get('items')
  findItems(@Query() query: any) {
    return this.dictService.findItems(query);
  }

  // 前端统一下拉数据源（无需鉴权过细，登录即可）
  @Get('options/:typeCode')
  async options(@Param('typeCode') typeCode: string, @Query('extValue') extValue?: string) {
    const list = await this.dictService.options(typeCode, extValue);
    return list.map((i: any) => ({
      value: i.itemCode,
      label: i.itemName,
      color: i.color,
      extField1: i.extField1,
    }));
  }

  /** 批量获取多个字典类型 */
  @Get('options')
  async optionsBatch(@Query('types') types: string) {
    const codes = (types || '').split(',').filter(Boolean);
    const result: Record<string, any[]> = {};
    for (const code of codes) {
      const list = await this.dictService.options(code);
      result[code] = list.map((i: any) => ({ value: i.itemCode, label: i.itemName, color: i.color, extField1: i.extField1 }));
    }
    return result;
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Post('items')
  createItem(@Body() body: any) {
    return this.dictService.createItem(body);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Put('items/:id')
  updateItem(@Param('id') id: string, @Body() body: any) {
    return this.dictService.updateItem(id, body);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Delete('items/:id')
  removeItem(@Param('id') id: string) {
    return this.dictService.removeItem(id);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Post('items/:id/toggle')
  toggleItem(@Param('id') id: string) {
    return this.dictService.toggleItem(id);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Post('items/sort')
  sortItems(@Body() body: { typeCode: string; ids: string[] }) {
    return this.dictService.sortItems(body);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Get('items/usage/:id')
  async itemUsage(@Param('id') id: string) {
    return this.dictService.itemUsageById(id);
  }

  @RequirePermissions('dict:view', 'system:config')
  @Get('export')
  async export(@Query('typeCode') typeCode: string, @Res() res: Response) {
    const buffer = await this.dictService.exportItems(typeCode);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=dict-${typeCode}.xlsx`);
    res.end(buffer);
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async import(@Query('typeCode') typeCode: string, @UploadedFile() file: any, @CurrentUser() user: any) {
    if (!file) return { created: 0, updated: 0 };
    return this.dictService.importItems(typeCode, file.buffer, { fileName: file?.originalname, user });
  }

  @RequirePermissions('dict:edit', 'system:config')
  @Post('cache/refresh')
  async refresh(@Body() body: any) {
    await this.dictService.refreshCache(body?.typeCode);
    return true;
  }
}
