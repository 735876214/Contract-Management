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
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { UploadedFiles } from '@nestjs/common';
import { Response } from 'express';
import { InvoiceService } from './invoice.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser, ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('invoices')
export class InvoiceController {
  constructor(private service: InvoiceService) {}

  @RequirePermissions('invoice:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('invoice:view', 'invoice:edit')
  @Get('check-no')
  checkNo(@Query('no') no: string, @Query('excludeId') excludeId: string, @ProjectId() projectId: string) {
    return this.service.checkNo(no, projectId, excludeId);
  }

  @RequirePermissions('invoice:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.service.export(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=invoices.xlsx');
    res.end(buffer);
  }

  @RequirePermissions('invoice:view')
  @Get('applies')
  findApplies(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findApplies(query, projectId);
  }

  @RequirePermissions('invoice:edit')
  @Post('applies')
  createApply(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.service.createApply(body, projectId, user);
  }

  @RequirePermissions('invoice:edit')
  @Delete('applies/:id')
  removeApply(@Param('id') id: string) {
    return this.service.removeApply(id);
  }

  @RequirePermissions('invoice:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('invoice:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  @RequirePermissions('invoice:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @RequirePermissions('invoice:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @RequirePermissions('invoice:edit')
  @Post(':id/verify')
  verify(@Param('id') id: string) {
    return this.service.verify(id);
  }

  @RequirePermissions('invoice:edit')
  @Post('recognize')
  @UseInterceptors(FilesInterceptor('files', 20))
  recognize(@UploadedFiles() files: any[]) {
    return this.service.recognize(files || []);
  }

  @RequirePermissions('invoice:edit')
  @Post('batch')
  batchCreate(@Body() body: any, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.service.batchCreate(body?.items || [], projectId, user);
  }

  @RequirePermissions('invoice:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  import(@UploadedFile() file: any, @ProjectId() projectId: string) {
    if (!file) return { created: 0, errors: ['未上传文件'] };
    return this.service.import(file.buffer, projectId);
  }
}
