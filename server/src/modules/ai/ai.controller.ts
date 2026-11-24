import {
  Body,
  Controller,
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
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { AiService, AnalyticsService, listAiPrompts, renderAiPrompt } from '../ai-insight/index.ts';
import { listContextDocs, renderContextDoc } from '../ai-insight/index.ts';
import { AiSettingService } from '../ai-core/ai-setting.service.ts';
import type { AiSettingInput, AiSettingTestInput } from '../ai-core/ai-setting.service.ts';
import { RegisterService, type RegisterConfirmInput } from '../ai-fill/index.ts';
import { ReportService } from '../ai-insight/index.ts';
import { AnomalyService, type PaymentAnomalyQuery } from '../ai-insight/index.ts';
import { QuoteService, type QuoteAnomalyQuery } from '../ai-fill/index.ts';
import { FulfillmentService, type FulfillmentAnomalyQuery } from '../ai-fill/index.ts';
import { ScmService, type ScmAnalysisQuery } from '../ai-insight/index.ts';
import { JwtAuthGuard } from '../auth';
import { PermissionsGuard } from '../auth';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.ts';
import { CurrentUser, JwtUser, ProjectId } from '../../common/decorators/user.decorator.ts';
import { sendFile } from '../../common/http/download.ts';

/**
 * 上传限额：multer 层 50MB 是**硬上限**（与 nginx `client_max_body_size 50m`、
 * `files/upload` 同口径），业务上限是 `ai-config.ts` 的 `maxFileBytes`（默认 5MB，可用
 * `AI_MAX_FILE_BYTES` 调）。两层是有意的：multer 拦「大到会把内存打爆的包」，
 * service 层给「文件超限」这句人话（2026-10-20 审计 P2 记录过两者不一致，这里写明口径）。
 */
const AI_UPLOAD = { storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } };

/** multipart 只能传文本：projectIds 允许 JSON 数组串或逗号分隔串 */
const parseProjectIds = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
};

/** 表单填报的共享上下文（inspect/fill 口径一致） */
const formContext = (body: any, projectId: string) => ({
  projectId,
  contractId: body?.contractId || null,
  supplierId: body?.supplierId || null,
  scope: body?.scopeMode
    ? { mode: body.scopeMode as 'current' | 'selected' | 'all', projectIds: parseProjectIds(body.projectIds) }
    : undefined,
  period: body?.from || body?.to ? { from: body?.from, to: body?.to } : undefined,
});

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
    private setting: AiSettingService,
    private register: RegisterService,
    private report: ReportService,
    private anomaly: AnomalyService,
    private quote: QuoteService,
    private fulfillment: FulfillmentService,
    private scm: ScmService,
    /** 问数（P3-A）：复用 analytics 的意图/取数/对账/留痕，只换产出形态 */
    private ai: AnalyticsService,
  ) {}

  /**
   * AI 信息登记（系统管理 → AI 信息登记页面用）。
   *
   * 与下面的业务接口**分开权限**：这些接口改的是全站共用的上游配置（地址/密钥/模型），
   * 属于「系统配置」而非常规业务操作，所以要求 `system:config` 而不是 `ai:view`。
   * 密钥只写不读——`view()` 只回「有没有存过」，永远不回明文。
   */
  @RequirePermissions('system:config')
  @Get('setting')
  getSetting() {
    return this.setting.view();
  }

  // @body: typed=inline
  @RequirePermissions('system:config')
  @Put('setting')
  saveSetting(@Body() body: AiSettingInput) {
    return this.setting.save(body || {});
  }

  /** 用当前（或页面上刚填、还没保存的）配置真打一次上游，只做诊断，不改任何状态；`purpose` 可指定测哪个用途 */
  // @body: typed=inline
  @RequirePermissions('system:config')
  @Post('setting/test')
  testSetting(@Body() body: AiSettingTestInput) {
    return this.setting.test(body || {});
  }

  /** 前端据此决定「AI 助手」菜单是否可用（未配置时显示"未启用"而不是报错） */
  @RequirePermissions('ai:view')
  @Get('status')
  status() {
    return this.service.status();
  }

  /**
   * 口径提示词目录（**只读、纯静态文本**，不含任何业务数据或密钥）。
   *
   * 主要消费方是 `mcp/`：外部 AI 通过 MCP 的 `prompts/list` / `prompts/get` 拿到同一份口径原文，
   * 于是「怎么写汇报材料」「异常预警的红线」在站内 AI 与外部 AI 之间只有一份定义。
   * 正文仍由各 prompt 文件持有，本接口只做曝光（见 `ai-insight/prompt-catalog.ts`）。
   */
  @RequirePermissions('ai:view')
  @Get('prompts')
  prompts() {
    return { prompts: listAiPrompts() };
  }

  /** 渲染指定口径提示词；`kind`/`extra` 等参数走 query string */
  @RequirePermissions('ai:view')
  @Get('prompts/:key')
  prompt(@Param('key') key: string, @Query() query: any) {
    return renderAiPrompt(key, query || {});
  }

  /* ---------------- AI 问数（P3-A） ---------------- */

  /**
   * 问数可用性 + 可问的数据集（按权限过滤）。
   *
   * 前端据此决定输入框是否可点、以及「你可以问这些」的提示。
   * `deniedDatasets` 单独列出：让用户知道是被权限挡住的，而不是系统没这个数据。
   */
  @RequirePermissions('ai:view')
  @Get('chat/status')
  async chatStatus(@CurrentUser() user: JwtUser) {
    const cfg = await this.service.status();
    const datasets = await this.ai.listDatasets(user);
    return {
      enabled: cfg.enabled,
      model: cfg.model,
      hourlyLimitPerUser: cfg.hourlyLimitPerUser,
      maxQuestionChars: 2000,
      ...datasets,
    };
  }

  /**
   * **问数**：一次问答。数字全部由程序算（DatasetCollector），模型只组织语言，
   * 回答里的数字逐条回查；对不上就整段丢弃、退回事实摘要并告知前端。
   *
   * 默认统计范围 = **当前项目**（`x-project-id`）；显式传 `scope` 可跨项目（需 `dashboard:view`）。
   */
  // @body: typed=inline
  @RequirePermissions('ai:use')
  @Post('chat/ask')
  ask(
    @Body() body: { text?: string; scope?: any; period?: any; datasets?: string[]; compare?: string; notes?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.ai.ask(body || {}, projectId, user);
  }

  /**
   * **问数（流式）**：SSE，事件序列 `phase` → `delta`×N → `final` → `done`（异常 `error`）。
   *
   * 为什么流式：一次问数要 5~20 秒（取数 + 两次上游调用），非流式体验是「点了没反应」。
   *
   * ⚠️ 前端必须**用 `final` 事件的正文覆盖已流出的文字**：`delta` 出的是模型原文，
   * 对账不通过时会被整段作废，最终正文换成程序直出的事实汇总——
   * 不覆盖就会让用户把作废的内容当成结论。
   *
   * 与非流式 `/chat/ask` 共用 `prepareAsk()`（同一套取数口径），差异只在叙述方式与工具循环。
   */
  // @body: typed=inline
  @RequirePermissions('ai:use')
  @Post('chat/ask/stream')
  async askStream(
    @Body() body: { text?: string; scope?: any; period?: any; datasets?: string[]; compare?: string; notes?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx 默认会缓冲 SSE，关掉它（与 deploy/nginx 的 proxy_buffering 同口径）
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const emit = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // 心跳：取数阶段可能十几秒没有 delta，没有心跳会被中间代理掐断
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    try {
      const result = await this.ai.streamAsk(body || {}, projectId, user, emit);
      emit('done', result);
    } catch (e: any) {
      emit('error', { message: e?.message || '问数失败' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  /** 问答历史（只回问答记录：`answerMode` 由服务端强制为 chat，不接受客户端传入） */
  @RequirePermissions('ai:view')
  @Get('chat/records')
  chatRecords(@Query() query: any, @CurrentUser() user: JwtUser) {
    return this.ai.listRecords(user, { ...(query || {}), answerMode: 'chat' });
  }

  /** 单条问答详情（含当时的事实快照与对账结果；非创建人 404） */
  @RequirePermissions('ai:view')
  @Get('chat/records/:id')
  chatRecord(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.ai.getRecord(id, user);
  }

  /**
   * 口径上下文目录（**只读、纯静态文本**）：状态码与统计排除项 / 采购工作流 / 报表指标口径。
   *
   * 消费方是 `mcp/` 的 resources 原语：外部 AI 拿到 `status: 'PARTIAL'` 之后要能查到它的含义，
   * 以及「哪些状态不计入统计」这种口径级规则——否则它会自己发明一套。
   * 内容全部由 `server/src/constants/*` 生成（见 `context-catalog.ts`），没有第二份手写稿。
   */
  @RequirePermissions('ai:view')
  @Get('context')
  contextList() {
    return { docs: listContextDocs() };
  }

  /** 渲染指定口径文档（markdown 正文） */
  @RequirePermissions('ai:view')
  @Get('context/:key')
  contextDoc(@Param('key') key: string) {
    return renderContextDoc(key);
  }

  /**
   * 上传 Excel 表单 → 返回「单元格 ↔ 字段」建议。
   * `contractId` 可选：给了才能用 `contract.*` / `supplier.*` 字段。
   */
  // @body: typed=inline
  @RequirePermissions('ai:use')
  @Post('forms/inspect')
  @UseInterceptors(FileInterceptor('file', AI_UPLOAD))
  inspect(
    @UploadedFile() file: any,
    @Body() body: { contractId?: string; supplierId?: string; scopeMode?: string; projectIds?: string; from?: string; to?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.inspectForm(file, formContext(body, projectId), user);
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
  @UseInterceptors(FileInterceptor('file', AI_UPLOAD))
  parseRegister(@UploadedFile() file: any, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.register.parse(file, { projectId }, user?.userId || user?.username || 'anonymous');
  }

  /**
   * 把确认过的字段写库（供应商可复用已有 / 新建，合同走 ContractService.create）。
   * 权限按动作判，**不是「二选一」**：守卫是 OR 语义，写 `('contract:edit','supplier:edit')`
   * 会让只有 supplier:edit 的岗位也能建合同（2026-10-20 审计 P1）。这里卡 `contract:edit`，
   * 新建供应商时再由 service 追加校验 `supplier:edit`。
   */
  // @body: typed=inline
  @RequirePermissions('contract:edit')
  @Post('register/confirm')
  confirmRegister(@Body() body: RegisterConfirmInput, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.register.confirm(body, { projectId }, user);
  }

  /**
   * 汇报材料（三期）：由**程序**聚合事实、模型只负责组织语言。
   * 返回 Markdown + 事实清单 + 对账结果（`unknownNumbers` = 材料里出现但系统数据对不上的数字）。
   */
  // @body: typed=inline
  @RequirePermissions('ai:use')
  @Post('report/generate')
  generateReport(
    @Body() body: { kind?: string; from?: string; to?: string; extra?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.report.generate(body || {}, projectId, user);
  }

  /**
   * 把页面上的同一份 Markdown 导出为 docx / pdf（不重新生成，避免导出与预览不一致）。
   * `format=pdf` 需要服务器有中文字体（未安装时返回 400 并给出安装提示）。
   */
  /**
   * 统计区间体检（`anomaly/payment` 的前置问询）——**只读**、不取任何业务数据。
   *
   * 面板点「开始扫描」前先问一句这段区间行不行：超上限时弹「仍然扫描」确认，确认后带 `force=1` 重发。
   * 放在服务端算的理由是**口径只有一份**——默认跨度与上限都来系统参数，前端自己算月份立刻会与后端不一致。
   * `allowed=false` 不是错误（面板要拿它弹确认框）；日期格式错/起止颠倒才 400。
   */
  @RequirePermissions('ai:view')
  @Get('anomaly/window')
  anomalyWindow(@Query() query: PaymentAnomalyQuery) {
    return this.anomaly.window(query || {});
  }

  /**
   * 结算 / 付款异常预警（课题 6-9）——**只读**，不写库、不发通知。
   *
   * 权限：`ai:view` 够看结果，但命中项带合同/结算/付款金额，
   * service 里会再要 `contract:view`（与汇报材料同口径的敏感数据保护）。
   *
   * 参数全部可选：`from`/`to`（结算日期区间，YYYY-MM-DD）、`contractId`（只看单合同）、
   * `narrative=0`（只看规则结果，不调模型）、`force=1`（人工确认「超过取数上限也照扫」）。
   *
   * 不给 `from`/`to` 时按系统默认取近 12 个自然月；区间超过上限（默认 24 个月）且没带 `force=1`
   * 一律 **400** 并说清「超了多少 / 上限多少 / 怎么继续」——不截断，截断会让结论看起来完整但少算单据。
   */
  @RequirePermissions('ai:view')
  @Get('anomaly/payment')
  paymentAnomaly(@Query() query: PaymentAnomalyQuery, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.anomaly.payment(query || {}, projectId, user);
  }

  /**
   * 异常报价与价差识别预警（课题 3-9）——**只读**，不写库、不改任务状态、不发通知。
   *
   * 权限：路由层 `ai:view`；命中项带供应商报价与控制价，service 里再要 `contract:view`
   * （与采购任务详情同一敏感级别）。
   *
   * 参数全部可选：`taskId`（只看单个采购任务）、`narrative=0`（只看规则结果，不调模型）。
   */
  @RequirePermissions('ai:view')
  @Get('anomaly/quote')
  quoteAnomaly(@Query() query: QuoteAnomalyQuery, @ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.quote.quote(query || {}, projectId, user);
  }

  /**
   * 合同履行偏差预警（课题 4-9）——**只读**，不写库、不改节点状态、不发通知。
   *
   * 权限：路由层 `ai:view`；命中项带合同金额与付款进度，service 里再要 `contract:view`。
   *
   * 参数全部可选：`contractId`（只看单个合同）、`narrative=0`（只看规则结果，不调模型）。
   */
  @RequirePermissions('ai:view')
  @Get('anomaly/fulfillment')
  fulfillmentAnomaly(
    @Query() query: FulfillmentAnomalyQuery,
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.fulfillment.fulfillment(query || {}, projectId, user);
  }

  /**
   * 供应链运营全景（课题 7-11）——**只读**，不写库、不发通知。
   *
   * 与前三个预警不同：它是**跨项目**的，所以不接 `@ProjectId()`——项目集合由前端显式传
   * （`projectIds=a,b,c`，最多 20 个；不传 = 全部项目）。权限三层：
   * 路由 `ai:view`、service `contract:view`、跨项目（>1 个或不指定）另需 `dashboard:view`。
   *
   * `narrative=0`：只出确定性汇总（不调模型）。
   */
  @RequirePermissions('ai:view')
  @Get('analysis/supply-chain')
  supplyChain(@Query() query: ScmAnalysisQuery, @CurrentUser() user: JwtUser) {
    return this.scm.panorama(query || {}, user);
  }

  // @body: typed=inline
  @RequirePermissions('ai:use')
  @Post('report/export')
  async exportReport(
    @Body() body: { markdown?: string; title?: string; header?: string; footer?: string; format?: string },
    @Res() res: Response,
  ) {
    const isPdf = String(body?.format || 'docx').toLowerCase() === 'pdf';
    const { buffer, fileName } = isPdf
      ? await this.report.exportPdf(body || {})
      : await this.report.exportDocx(body || {});
    sendFile(res, fileName, buffer, isPdf ? 'pdf' : 'docx', {
      'Access-Control-Expose-Headers': 'Content-Disposition',
    });
  }

  // @body: typed=inline
  @RequirePermissions('ai:use')
  @Post('forms/fill')
  @UseInterceptors(FileInterceptor('file', AI_UPLOAD))
  async fill(
    @UploadedFile() file: any,
    @Body() body: { mapping?: string; contractId?: string; supplierId?: string; scopeMode?: string; projectIds?: string; from?: string; to?: string },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    const result = await this.service.fillForm(
      file,
      body?.mapping,
      formContext(body, projectId),
      user,
    );
    // 统计放进响应头：附件流的正文是二进制，前端拿不到 JSON
    sendFile(res, result.fileName, result.buffer, 'xlsx', {
      'x-ai-filled': String(result.filled),
      'x-ai-skipped': String(result.skipped.length),
      'Access-Control-Expose-Headers': 'x-ai-filled, x-ai-skipped, Content-Disposition',
    });
  }

  /**
   * 行级表格填充：把数据集的行写进模板的表区（列映射由前端选择）。
   * 返回 xlsx 附件 + `x-ai-filled-rows / x-ai-skipped / x-ai-truncated` 统计头。
   */
  // @body: typed=inline
  @RequirePermissions('ai:use')
  @Post('forms/fill-table')
  @UseInterceptors(FileInterceptor('file', AI_UPLOAD))
  async fillTable(
    @UploadedFile() file: any,
    @Body()
    body: {
      datasetKey?: string;
      sheet?: string;
      headerRow?: string;
      startRow?: string;
      columns?: string;
      contractId?: string;
      supplierId?: string;
      scopeMode?: string;
      projectIds?: string;
      from?: string;
      to?: string;
    },
    @ProjectId() projectId: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    const result = await this.service.fillTable(file, body || {}, formContext(body, projectId), user);
    sendFile(res, result.fileName, result.buffer, 'xlsx', {
      'x-ai-filled-rows': String(result.filledRows),
      'x-ai-skipped': String(result.skippedCells),
      'x-ai-truncated': result.truncated ? '1' : '0',
      'Access-Control-Expose-Headers': 'x-ai-filled-rows, x-ai-skipped, x-ai-truncated, Content-Disposition',
    });
  }
}
