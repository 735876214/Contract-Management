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
import { DailyReportService } from './daily-report.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId, CurrentUser, JwtUser } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('daily-reports')
export class DailyReportController {
  constructor(private service: DailyReportService) {}

  @RequirePermissions('daily:view')
  @Get()
  findAll(@Query() query: any, @ProjectId() projectId: string) {
    return this.service.findAll(query, projectId);
  }

  @RequirePermissions('daily:view')
  @Get('material-types')
  materialTypes(@Query('category') category: string) {
    return this.service.materialTypes(category);
  }

  @RequirePermissions('daily:view')
  @Get('export')
  async export(@ProjectId() projectId: string, @Res() res: Response) {
    const buffer = await this.service.export(projectId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=daily-reports.xlsx');
    res.end(buffer);
  }

  @RequirePermissions('daily:view')
  @Get('contract-settled-qty')
  contractSettledQty(@Query('contractId') contractId: string, @ProjectId() projectId: string) {
    return this.service.contractSettledQty(contractId, projectId);
  }

  /** 某合同下未确认/已驳回的现场记录汇总（结算页提示用，.claude/rules/backend-conventions.md「日报/现场确认」） */
  @RequirePermissions('daily:view')
  @Get('unconfirmed-summary')
  unconfirmedSummary(@Query('contractId') contractId: string, @ProjectId() projectId: string) {
    return this.service.unconfirmedSummary(contractId, projectId);
  }

  @RequirePermissions('daily:view')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @RequirePermissions('daily:edit')
  @Post()
  create(@Body() body: any, @ProjectId() projectId: string) {
    return this.service.create(body, projectId);
  }

  @RequirePermissions('daily:edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  /**
   * 现场确认/驳回：单条传 `id`，批量传 `ids`。
   * 权限沿用 `daily:edit`（填报人=确认人同权）；若要分离填报与确认，需新增权限码 daily:confirm。
   */
  @RequirePermissions('daily:edit')
  @Post('confirm')
  confirm(
    @Body() body: { id?: string; ids?: string[]; action: string; remark?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
  ) {
    const { id, ids, action, remark } = body ?? ({} as any);
    if (id) return this.service.confirmOne(id, action, projectId, user, remark);
    return this.service.confirmMany(ids ?? [], action, projectId, user, remark);
  }

  @RequirePermissions('daily:edit')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @RequirePermissions('daily:edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  import(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: any) {
    if (!file) return { created: 0, errors: ['未上传文件'] };
    return this.service.import(file.buffer, projectId, { fileName: file?.originalname, user });
  }
}
