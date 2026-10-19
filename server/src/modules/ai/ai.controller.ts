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
import { RegisterService, type RegisterConfirmInput } from './register.service';
import { ReportService } from './report.service';
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
 * ⚠️ **一期不落任何业务数据**：扫描 / 回填都是「输入文件 → 输出文件/建议」，
 * 不写库、不存盘（回填结果直接以附件流回传）。这样 AI 出错的最坏后果是下载到一个错的表。
 * 二期「文件登记」拆成 `register/parse`（**只解析，不写库**）+ `register/confirm`
 * （写库，且必须先经人确认）——与两阶段导入同一口径：先出结果给人看，确认后才落库。
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('ai')
export class AiController {
  constructor(
    private service: AiService,
    private register: RegisterService,
    private report: ReportService,
  ) {}

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
  /**
   * 合同文件（.docx / .xlsx）→ 登记草案。
   * **只解析不写库**：返回字段值、原文核对结果、交叉校验告警与明细，
   * 由人在前端逐项确认后再调 `register/confirm`。
   */
  @RequirePermissions('ai:use')
  @Post('register/parse')
  @UseInterceptors(FileInterceptor('file'))
  parseRegister(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.register.parse(file, { projectId }, user?.userId || user?.username || 'anonymous');
  }

  /**
   * 把确认过的字段写库（供应商可复用已有 / 新建，合同走 ContractService.create）。
   * 写库权限按各模块自己的编辑权限判：`ai:use` 只代表"能用 AI"，不代表"能建合同"。
   */
  @RequirePermissions('contract:edit', 'supplier:edit')
  @Post('register/confirm')
  confirmRegister(@Body() body: RegisterConfirmInput, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.register.confirm(body, { projectId }, user);
  }

  /**
   * 汇报材料（三期）：由**程序**聚合事实、模型只负责组织语言。
   * 返回 Markdown + 事实清单 + 对账结果（`unknownNumbers` = 材料里出现但系统数据对不上的数字）。
   */
  @RequirePermissions('ai:use')
  @Post('report/generate')
  generateReport(
    @Body() body: { kind?: string; from?: string; to?: string; extra?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.report.generate(body || {}, projectId, user?.userId || user?.username || 'anonymous');
  }

  /** 把页面上的同一份 Markdown 导出为 docx（不重新生成，避免导出与预览不一致） */
  @RequirePermissions('ai:use')
  @Post('report/export')
  async exportReport(@Body() body: { markdown?: string; title?: string }, @Res() res: Response) {
    const { buffer, fileName } = await this.report.exportDocx(body || {});
    res.setHeader('Content-Type', this.service.docxMime);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report.docx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(buffer);
  }

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
