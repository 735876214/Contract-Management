import {
  Body,
  Controller,
  Get,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser, ProjectId } from '../../common/decorators/user.decorator';

/**
 * AI 助手（模块前缀 `api/ai`）。
 *
 * 权限：
 * - `ai:view`：看状态与字段目录；
 * - `ai:use`：真正消耗 AI 配额的两个动作（扫描 / 回填）。
 * 两者分开是为了让「只读用户看到入口但点不动」变成明确的 403，而不是静默隐藏。
 *
 * ⚠️ **不落任何业务数据**：一期两个接口都是「输入文件 → 输出文件/建议」，
 * 不写库、不存盘（回填结果直接以附件流回传）。这样 AI 出错的最坏后果是下载到一个错的表，
 * 而不是系统里多出一堆脏数据 —— 登记类能力（二期）才需要落库，届时按两阶段导入的规矩来。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('ai')
export class AiController {
  constructor(private service: AiService) {}

  /** 前端据此决定「AI 助手」菜单是否可用（未配置时显示"未启用"而不是报错） */
  @RequirePermissions('ai:view')
  @Get('status')
  status() {
    return this.service.status();
  }

  /**
   * 上传 Excel 表单 → 返回「单元格 ↔ 字段」建议。
   * `contractId` 可选：给了才能用 `contract.*` / `supplier.*` 字段。
   */
  @RequirePermissions('ai:use')
  @Post('forms/inspect')
  @UseInterceptors(FileInterceptor('file'))
  inspect(
    @UploadedFile() file: any,
    @Body() body: { contractId?: string; supplierId?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.inspectForm(
      file,
      { projectId, contractId: body?.contractId || null, supplierId: body?.supplierId || null },
      user?.userId || user?.username || 'anonymous',
    );
  }

  /**
   * 按映射回填并下载。
   * `mapping` 是 JSON 字符串（multipart 只能传文本字段）：`[{ sheet, cellRef, fieldKey }]`。
   */
  @RequirePermissions('ai:use')
  @Post('forms/fill')
  @UseInterceptors(FileInterceptor('file'))
  async fill(
    @UploadedFile() file: any,
    @Body() body: { mapping?: string; contractId?: string; supplierId?: string },
    @ProjectId() projectId: string,
    @Res() res: Response,
  ) {
    const result = await this.service.fillForm(
      file,
      body?.mapping,
      { projectId, contractId: body?.contractId || null, supplierId: body?.supplierId || null },
    );
    // 统计放进响应头：附件流的正文是二进制，前端拿不到 JSON
    res.setHeader('Content-Type', this.service.xlsxMime);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.fileName)}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    res.setHeader('x-ai-filled', String(result.filled));
    res.setHeader('x-ai-skipped', String(result.skipped.length));
    res.setHeader('Access-Control-Expose-Headers', 'x-ai-filled, x-ai-skipped, Content-Disposition');
    res.end(result.buffer);
  }
}
