import { Body, Controller, Get, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { LedgerService } from './ledger.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

/**
 * 合同台账接口：页面入口（`/contract/list`）按 `contract:view` 放行，
 * 而接口原先只认 `ledger:view` → 只勾了「合同查看」的角色能进页面却处处 403。
 * 两个权限码任一即可（`PermissionsGuard` 对多码取「或」），`ledger:view` 保留给
 * 只勾台账的老角色，不破坏既有授权。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('ledger')
export class LedgerController {
  constructor(private service: LedgerService) {}

  @RequirePermissions('ledger:view', 'contract:view')
  @Get('contracts')
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('ledger:view', 'contract:view')
  @Get('columns')
  columns() {
    return this.service.columns();
  }

  @RequirePermissions('ledger:view', 'contract:view')
  @Put('columns')
  saveColumns(@Body() body: Record<string, boolean>) {
    return this.service.saveColumns(body);
  }

  @RequirePermissions('ledger:view', 'contract:view')
  @Get('summary')
  summary(@ProjectId() projectId: string) {
    return this.service.summary(projectId);
  }

  @RequirePermissions('ledger:view', 'contract:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.service.export(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=contract-ledger.xlsx');
    res.end(buffer);
  }
}
