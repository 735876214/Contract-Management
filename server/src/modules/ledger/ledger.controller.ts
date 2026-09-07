import { Body, Controller, Get, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { LedgerService } from './ledger.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('ledger')
export class LedgerController {
  constructor(private service: LedgerService) {}

  @RequirePermissions('ledger:view')
  @Get('contracts')
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('ledger:view')
  @Get('columns')
  columns() {
    return this.service.columns();
  }

  @RequirePermissions('ledger:view')
  @Put('columns')
  saveColumns(@Body() body: Record<string, boolean>) {
    return this.service.saveColumns(body);
  }

  @RequirePermissions('ledger:view')
  @Get('summary')
  summary(@ProjectId() projectId: string) {
    return this.service.summary(projectId);
  }

  @RequirePermissions('ledger:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.service.export(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=contract-ledger.xlsx');
    res.end(buffer);
  }
}
