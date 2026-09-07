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

  @RequirePermissions('contract:view', 'daily:edit', 'settlement:edit', 'payment:edit', 'invoice:edit', 'repayment:edit', 'item:edit')
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
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.contractService.export(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=contracts.xlsx');
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
  @Post(':id/submit')
  submit(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.contractService.submit(id, user);
  }

  @RequirePermissions('contract:approve')
  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() body: { action: string; comment?: string }, @CurrentUser() user: JwtUser) {
    return this.contractService.approve(id, body.action, body.comment, user);
  }

  @RequirePermissions('contract:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  import(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    if (!file) return { created: 0, errors: ['未上传文件'] };
    return this.contractService.import(file.buffer, projectId, user);
  }
}
