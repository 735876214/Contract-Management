import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { RepaymentService } from './repayment.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('repayments')
export class RepaymentController {
  constructor(private service: RepaymentService) {}

  @RequirePermissions('repayment:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('repayment:edit')
  @Get('suggest-code')
  suggestCode(@ProjectId() projectId: string) {
    return this.service.suggestCode(projectId).then((code) => ({ code }));
  }

  @RequirePermissions('repayment:edit')
  @Get('check-code')
  checkCode(@Query('code') code: string, @Query('excludeId') excludeId: string, @ProjectId() projectId: string) {
    return this.service.checkCode(code, projectId, excludeId);
  }

  @RequirePermissions('repayment:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.service.export(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=repayments.xlsx');
    res.end(buffer);
  }

  @RequirePermissions('repayment:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('repayment:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  @RequirePermissions('repayment:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @RequirePermissions('repayment:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
