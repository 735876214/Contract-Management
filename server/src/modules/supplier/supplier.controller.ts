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
import { SupplierService } from './supplier.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('suppliers')
export class SupplierController {
  constructor(private supplierService: SupplierService) {}

  @RequirePermissions('supplier:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.supplierService.findAll(query, projectId);
  }

  @RequirePermissions('supplier:view', 'contract:edit', 'daily:edit', 'repayment:edit')
  @Get('options')
  options(@ProjectId() projectId: string, @Query('keyword') keyword?: string) {
    return this.supplierService.options(projectId, keyword);
  }

  @RequirePermissions('supplier:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.supplierService.export(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=suppliers.xlsx');
    res.end(buffer);
  }

  /** 下载填写模板（需求 3.3，须声明在 :id 通配路由之前） */
  @RequirePermissions('supplier:view')
  @Get('template')
  async template(@Res() res: Response) {
    const { buffer, filename } = await this.supplierService.template();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  @RequirePermissions('supplier:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.supplierService.findOne(id);
  }

  @RequirePermissions('supplier:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.supplierService.create(body, projectId);
  }

  @RequirePermissions('supplier:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.supplierService.update(id, body);
  }

  @RequirePermissions('supplier:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.supplierService.remove(id);
  }

  @RequirePermissions('supplier:edit')
  @Post(':id/toggle')
  toggle(@Param('id') id: string) {
    return this.supplierService.toggle(id);
  }

  @RequirePermissions('supplier:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  import(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return { created: 0, updated: 0, errors: ['未上传文件'] };
    return this.supplierService.import(file.buffer, projectId, { fileName: file?.originalname, user });
  }

}
