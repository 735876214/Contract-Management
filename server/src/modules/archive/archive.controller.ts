import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ArchiveService } from './archive.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ProjectId } from '../../common/decorators/user.decorator';

/**
 * 项目资料归档（附件需求 2026-10-17）：目录树查询 + 一键/按目录打包 ZIP 下载。
 *
 * ⚠️ ZIP 需要带鉴权的动态响应（`/api/files/<键>` 静态服务不带权限判断），
 * 故走 `@Res()` 流式输出——与各 Excel 导出同一写法；前端用 `withToken()` 携带 token。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('archive')
export class ArchiveController {
  constructor(private service: ArchiveService) {}

  @RequirePermissions('archive:view')
  @Get('entries')
  entries(@ProjectId() projectId: string) {
    return this.service.entries(projectId);
  }

  @RequirePermissions('archive:view')
  @Get('download')
  download(@ProjectId() projectId: string, @Query('scope') scope: string | undefined, @Res() res: Response) {
    return this.service.download(projectId, scope, res);
  }
}
