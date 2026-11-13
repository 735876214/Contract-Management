import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { localDayKey } from '../../common/utils/helpers';
import { assertPermission } from '../../common/utils/assert-permission';
import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { AiQuota } from './ai-quota';
import { aiModelFor, aiPublicStatus, type AiConfig } from './ai-config';
import { AiSettingService } from './ai-setting.service';
import { buildFormMappingMessages, normalizeMapping, type MappingSuggestion } from './ai-prompt';
import { AI_FIELD_CATALOG, aiFieldByKey, availableFields, filterFieldsByPermission, SCOPE_READ_PERMISSION, type AiFieldDef } from './field-catalog';
import { FormCandidate, FormCell, detectTableRegions, scanWorkbook, type FormTableRegion } from './form-scan';
import { FieldResolverService, type ResolveContext } from './field-resolver.service';
import { DatasetCollector } from './analytics/dataset-collector.service';
import { filterDatasets } from './analytics/dataset-registry';
import { datasetByKey } from './analytics/dataset-registry';
import { datasetColumnsOf } from './analytics/dataset-columns';
import { endOfDay, parseLocalDay } from './common/period';
import { chatJson, LlmError, type LlmMessage } from './llm-client';

/** 扫描上限：表单类文件很小，但**带格式的空表**可以有几十万行（Excel 记住用过的区域） */
const SCAN_MAX_ROWS = 500;
const SCAN_MAX_COLS = 60;
/** 单次回填的映射条数上限（超过说明用户在拿 AI 批量造表，不是填表） */
const MAX_MAPPING = 300;

/**
 * 发给前端的候选槽位：**扫描结果 + （可选）模型建议**。
 * 映射三项可空——AI 未配置/调用失败时仍要把槽位列出来，让用户手工选字段。
 */
export interface AiFormSuggestion {
  /** 模型建议对应的候选序号（1 起）；0 = 无建议 */
  candidateIndex: number;
  /** 建议字段键；null = 未匹配 */
  fieldKey: string | null;
  fieldLabel: string | null;
  /** 0~1；null = 未匹配 */
  confidence: number | null;
  sheet: string;
  cellRef: string;
  label: string;
  /** 该格是否已有内容（**只回布尔，不回值**：值里有账号/金额，不进响应体与操作日志） */
  hasValue: boolean;
  /** 该字段是否敏感（前端展示提示，值仍由服务端填） */
  sensitive: boolean;
}

export interface AiInspectResult {
  aiEnabled: boolean;
  /** AI 不可用时的原因（用户可继续手工映射） */
  aiMessage?: string;
  sheetNames: string[];
  candidates: AiFormSuggestion[];
  /** 超出扫描上限被丢弃的槽位数（前端提示精简文件） */
  truncated: number;
  /** 目录里还剩多少字段没被用上（前端「可手工补填」下拉） */
  availableFields: AiFieldDef[];
  /** 表格区（行级填充）：表头连排 + 下方连续空行 */
  tables?: FormTableRegion[];
  /** 可选数据集（已实现 + 有权限）及其 Excel 列，用于行级填充的列映射 */
  tableDatasets?: Array<{ key: string; label: string; columns: string[] }>;
}

export interface AiFillItem {
  sheet: string;
  cellRef: string;
  fieldKey: string;
}

export interface AiFillResult {
  buffer: Buffer;
  filled: number;
  /** 值取不到（项目/合同里没这个数据）而跳过的项 */
  skipped: string[];
  fileName: string;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CELL_REF_RE = /^[A-Z]{1,3}[1-9]\d{0,5}$/;

/** 从 ExcelJS 单元格取出纯文本（富文本/公式/日期都要归一） */
function cellText(cell: ExcelJS.Cell): string {
  const v: any = cell.value;
  if (v == null) return '';
  if (v instanceof Date) return localDayKey(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text ?? '').join('');
    if ('result' in v) return String((v as any).result ?? '');
    if ('text' in v) return String((v as any).text ?? '');
    if ('formula' in v) return '';
    return '';
  }
  return String(v);
}

@Injectable()
export class AiService {
  constructor(
    private prisma: PrismaClient,
    private resolver: FieldResolverService,
    /** 与「文件登记」共享同一份每用户配额 */
    private quota: AiQuota,
    /** 配置统一走「系统管理 → AI 信息登记」：页面登记 > 环境变量（见 ai-config.ts） */
    private setting: AiSettingService,
    /** 行级填充取数：与经营数据助手共用采集器（口径单一实现） */
    private collector: DatasetCollector,
  ) {}

  private async config(): Promise<AiConfig> {
    return this.setting.resolve();
  }

  /**
   * 填报范围收口（2026-11-12）：跨项目（selected/all）需要 `dashboard:view`，
   * 项目集合按 `ProjectMember` 过滤；跨项目必须给期间（否则"汇总值"没有语义）。
   * 跨项目时清空 contractId/supplierId —— 单据级字段没有汇总值。
   */
  private async resolveFormScope(ctx: ResolveContext, user: any): Promise<ResolveContext> {
    const mode = ctx.scope?.mode ?? 'current';
    if (mode === 'current') {
      return { ...ctx, scope: { mode: 'current', projectIds: [ctx.projectId] } };
    }
    assertPermission(user, 'dashboard:view', '跨项目填报需要「统计报表-查看」权限');
    if (!ctx.period?.from || !ctx.period?.to) {
      throw new BadRequestException('跨项目填报需要选择期间（开始与结束日期）');
    }
    const where: any = {};
    if (!user?.isSuperAdmin) {
      if (!user?.userId) throw new BadRequestException('缺少用户身份，无法校验项目权限');
      where.members = { some: { userId: user.userId } };
    }
    const allowed = await this.prisma.project.findMany({ where, select: { id: true } });
    const allowedIds = allowed.map((p) => p.id);
    const wanted = mode === 'selected' ? (ctx.scope?.projectIds ?? []) : allowedIds;
    const ids = wanted.filter((id) => allowedIds.includes(id));
    if (!ids.length) throw new BadRequestException('填报范围里没有有权限的项目');
    return { ...ctx, scope: { mode, projectIds: ids }, contractId: null, supplierId: null };
  }

  async status(): Promise<{
    enabled: boolean;
    model: string;
    maxFileBytes: number;
    maxCandidates: number;
    hourlyLimitPerUser: number;
    fieldCatalog: AiFieldDef[];
  }> {
    const cfg = await this.config();
    return {
      ...aiPublicStatus(cfg),
      maxFileBytes: cfg.maxFileBytes,
      maxCandidates: cfg.maxCandidates,
      hourlyLimitPerUser: cfg.hourlyLimitPerUser,
      // 目录本身不是秘密（就是"系统有哪些字段"），下发给前端做手工映射下拉
      fieldCatalog: AI_FIELD_CATALOG.slice(),
    };
  }

  /** 配额：滑动 1 小时窗口。超限抛 429（前端提示"稍后再试"），不做静默降级 */
  /** 当前请求人（额度按用户计，兼容只有 username 的旧 token） */
  private userIdOf(user: any): string {
    return user?.userId || user?.username || 'anonymous';
  }

  /** 超管恒通过，其余按权限码判断（与 PermissionsGuard 同口径，避免两套判定打架） */
  private canReader(user: any): (code: string) => boolean {
    const perms: string[] = Array.isArray(user?.permissions) ? user.permissions : [];
    return (code: string) => Boolean(user?.isSuperAdmin) || perms.includes(code);
  }

  private consumeQuota(userId: string, cfg: AiConfig): void {
    this.quota.consume(userId, cfg.hourlyLimitPerUser);
  }

  /** 只接受 .xlsx：.xlsm 的宏经 ExcelJS 写出会**静默丢失**（与单据模板同一口径） */
  private assertUpload(file: any, cfg: AiConfig): { buffer: Buffer; fileName: string } {
    if (!file?.buffer?.length) throw new BadRequestException('请上传 Excel 文件');
    const name = String(file.originalname || 'upload.xlsx');
    if (!/\.xlsx$/i.test(name)) {
      throw new BadRequestException('只支持 .xlsx 文件（.xls/.xlsm 的宏与公式会在处理中丢失，请另存为 .xlsx）');
    }
    if (file.size && file.size > cfg.maxFileBytes) {
      throw new BadRequestException(`文件超过 ${Math.round(cfg.maxFileBytes / 1024 / 1024)}MB，请拆分后上传`);
    }
    return { buffer: file.buffer as Buffer, fileName: name };
  }

  /** xlsx → 文本矩阵（只读；跳过合并从属格与空串） */
  private async readCells(buffer: Buffer): Promise<{ wb: ExcelJS.Workbook; sheetNames: string[]; cells: FormCell[] }> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as any);
    } catch (e: any) {
      // 损坏文件 / 加密文件 / 其实是 csv 改名：ExcelJS 抛的英文异常会变成 500，换成能指导用户的话
      throw new BadRequestException(
        `这个文件打不开（${String(e?.message || e).slice(0, 120)}）：请确认是 Excel 另存的 .xlsx，未设置密码，且没有损坏`,
      );
    }
    const cells: FormCell[] = [];
    const sheetNames: string[] = [];
    wb.eachSheet((ws) => {
      sheetNames.push(ws.name);
      const rowLimit = Math.min(ws.rowCount, SCAN_MAX_ROWS);
      const colLimit = Math.min(ws.columnCount, SCAN_MAX_COLS);
      for (let r = 1; r <= rowLimit; r++) {
        for (let c = 1; c <= colLimit; c++) {
          const cell = ws.getCell(r, c);
          // 合并区域的从属格没有独立值；主格照常读（标签常是合并格）
          if (cell.isMerged && (cell.master as ExcelJS.Cell)?.address !== cell.address) continue;
          const t = cellText(cell);
          if (!t.trim()) continue;
          cells.push({ sheet: ws.name, row: r, col: c, text: t });
        }
      }
    });
    return { wb, sheetNames, cells };
  }

  /**
   * 扫描上传的表单，给出「哪一格该填哪个字段」的建议。
   *
   * AI 不可用（未配置 / 上游超时 / 返回乱码）时**不报错**：返回空建议 + 原因，
   * 用户仍可用前端的「手工映射」把表格填掉 —— AI 是加速器，不是唯一通路。
   */
  async inspectForm(
    file: any,
    ctx: ResolveContext,
    user: any,
  ): Promise<AiInspectResult> {
    const cfg = await this.config();
    ctx = await this.resolveFormScope(ctx, user);
    const { buffer } = this.assertUpload(file, cfg);
    const { sheetNames, cells } = await this.readCells(buffer);

    const { candidates, truncated } = scanWorkbook(cells, cfg.maxCandidates);
    const crossProject = (ctx.scope?.mode ?? 'current') !== 'current';
    const tables = detectTableRegions(cells, 10);
    const { visible } = filterDatasets(this.canReader(user));
    const tableDatasets = visible
      .filter((d) => datasetColumnsOf(d.key).length > 0)
      .map((d) => ({ key: d.key, label: d.label, columns: [...datasetColumnsOf(d.key)] }));
    const hasContract = !crossProject && Boolean(ctx.contractId);
    const allFields = availableFields({
      hasContract,
      hasSupplier: hasContract || Boolean(ctx.supplierId),
      crossProject,
    });
    // 只能列出「这个人有权读」的字段（见 field-catalog.SCOPE_READ_PERMISSION）
    const { fields, denied } = filterFieldsByPermission(allFields, this.canReader(user));
    const deniedNote = denied.length
      ? `（另有 ${denied.length} 个字段因你没有 ${[...new Set(denied.map((d) => d.scope))].join('/')} 数据的读取权限而没有列出）`
      : '';

    /**
     * 候选先按「原样列出」建好（`fieldKey: null` = 还没匹配），后续只做**填充**不做删减。
     * 曾经的坑：`base.candidates` 写死 `[]`，只有拿到模型建议后才回填 → AI 未配置时
     * 明明扫到了槽位却返回空列表，用户连手工映射的入口都没有。
     */
    const base: AiInspectResult = {
      aiEnabled: cfg.enabled,
      sheetNames,
      candidates: candidates.map((c) => ({
        candidateIndex: 0,
        fieldKey: null,
        fieldLabel: null,
        confidence: null,
        sheet: c.sheet,
        cellRef: c.cellRef,
        label: c.label,
        hasValue: Boolean(c.currentValue),
        sensitive: false,
      })),
      truncated,
      availableFields: fields,
      tables,
      tableDatasets,
    };

    if (!candidates.length) {
      return { ...base, aiMessage: '没有识别到可填写的表单项（表格里没有"标签 + 空白格"的结构）' + deniedNote };
    }

    const candByIndex = new Map<number, FormCandidate>(
      candidates.map((c, i) => [i + 1, c] as [number, FormCandidate]),
    );

    let suggestions: MappingSuggestion[] = [];
    if (!cfg.enabled) {
      return { ...base, aiMessage: 'AI 未配置（接口地址 / API Key / 模型名），可用手工映射填报；管理员可在「系统管理 → AI 信息登记」补上' + deniedNote };
    }

    const messages: LlmMessage[] = buildFormMappingMessages({
      fields,
      candidates,
      maxFields: cfg.maxFieldsInPrompt,
      maxCandidates: cfg.maxCandidates,
      // 没有关联合同时，模型常把「合同金额/合同编号」硬套到不存在的合同字段上，
      // 那样的建议会被下面的可用字段白名单丢掉，不如提前告诉它用统计口径或留空。
      note: crossProject
        ? '本次是跨项目汇总填报：只能使用 period.*（本期发生额）/ cross.*（跨项目聚合）与项目基础字段；不要使用 contract.* / supplier.* 单据级字段。'
        : hasContract
          ? undefined
          : '本次未关联任何合同：不要使用 contract.* 字段。表单里的「合同金额/累计金额」类标签可用 stats.* 统计字段；「合同编号/签订日期」这类没有对应统计口径的，请留空不选。',
    });

    const uid = this.userIdOf(user);
    this.consumeQuota(uid, cfg);
    try {
      const { data } = await chatJson(globalThis.fetch, {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        // 表单核验：短文本 + 只要结构化 JSON，管理员可以单独给它配便宜模型
        model: aiModelFor(cfg, 'form_inspect'),
        timeoutMs: cfg.timeoutMs,
        maxTokens: 2000,
      }, messages);
      if (data == null) {
        return { ...base, aiMessage: 'AI 返回内容无法解析为映射结果，请手工映射' + deniedNote };
      }
      suggestions = normalizeMapping(data, candByIndex.size);
    } catch (e) {
      const msg = e instanceof LlmError ? e.message : (e as Error)?.message || 'AI 调用失败';
      // 失败不占额度（2026-10-20 审计 P2）
      this.quota.refund(uid);
      return { ...base, aiMessage: `${msg}（可手工映射继续）` };
    }

    /**
     * 只**填充**匹配结果，不删减槽位：模型可能只挑出部分字段（例如只认得出 3 个），
     * 用户仍需看到剩下的槽位自己补选。曾经的坑：这里重建数组 → 未匹配的槽位整行消失。
     */
    // 只接受**这次请求可用**的字段：模型会凭直觉给出 `contract.code` 这类本次没下发的键
    // （没关联合同时合同域字段不该出现），若原样回给前端，用户会看到「已选好」却永远填不进去。
    const allowed = new Set(fields.map((f) => f.key));
    const byIndex = new Map<number, MappingSuggestion>();
    for (const s of suggestions) {
      const cand = candByIndex.get(s.candidateIndex);
      if (!cand || !allowed.has(s.fieldKey)) continue;
      // 同一候选只留置信度最高的一条（normalizeMapping 已去重，这里再兜一次）
      const prev = byIndex.get(s.candidateIndex);
      if (!prev || (s.confidence ?? 0) > (prev.confidence ?? 0)) byIndex.set(s.candidateIndex, s);
    }

    const merged = base.candidates.map((c, i) => {
      const s = byIndex.get(i + 1);
      if (!s) return c;
      const def = aiFieldByKey(s.fieldKey);
      return {
        ...c,
        candidateIndex: s.candidateIndex,
        fieldKey: s.fieldKey,
        fieldLabel: s.fieldLabel,
        confidence: s.confidence,
        sensitive: Boolean(def?.sensitive),
      };
    });

    return { ...base, candidates: merged };
  }

  /**
   * 按映射回填并返回新文件（**原位写回，保留原表样式与公式**）。
   * 取不到值的项跳过并回报（不写空串 —— 空串会把用户表里原有的格式/提示覆盖掉）。
   */
  async fillForm(
    file: any,
    mappingRaw: unknown,
    ctx: ResolveContext,
    user: any,
  ): Promise<AiFillResult> {
    const cfg = await this.config();
    ctx = await this.resolveFormScope(ctx, user);
    const { buffer, fileName } = this.assertUpload(file, cfg);

    /**
     * 字段白名单之外再加一道**读权限**过滤：`ai:use` 不等于 `contract:view` / `supplier:view`。
     * 否则一个只有 ai:use 的岗位可以上传一张空表 + 手写 mapping，把项目里的合同金额、
     * 供应商银行账号逐个抄出来（2026-10-20 审计 P3）。
     */
    const can = this.canReader(user);
    const crossProject = (ctx.scope?.mode ?? 'current') !== 'current';
    const blocked: string[] = [];
    const items = this.parseMapping(mappingRaw).filter((it) => {
      const def = aiFieldByKey(it.fieldKey);
      if (crossProject && def && (def.scope === 'contract' || def.scope === 'supplier')) {
        blocked.push(`${it.fieldKey} @ ${it.sheet}!${it.cellRef}（跨项目填报不提供单据级字段）`);
        return false;
      }
      const code = def ? SCOPE_READ_PERMISSION[def.scope] : undefined;
      if (code && !can(code)) {
        blocked.push(`${it.fieldKey} @ ${it.sheet}!${it.cellRef}（缺少 ${code} 权限）`);
        return false;
      }
      return true;
    });
    if (!items.length) {
      throw new ForbiddenException(
        `没有可回填的字段：这些字段所属的数据你没有读取权限${blocked.length ? `（${blocked[0]}）` : ''}`,
      );
    }
    const { wb } = await this.readCells(buffer);

    // 一次取全值：同一字段可能填到多格
    const keys = [...new Set(items.map((i) => i.fieldKey))];
    const values = await this.resolver.resolve(keys, ctx);

    let filled = 0;
    const skipped: string[] = [];
    for (const item of items) {
      const value = values[item.fieldKey] ?? '';
      if (!value) {
        skipped.push(`${item.fieldKey} @ ${item.sheet}!${item.cellRef}`);
        continue;
      }
      const ws = wb.getWorksheet(item.sheet);
      if (!ws) {
        skipped.push(`${item.fieldKey} @ ${item.sheet}!${item.cellRef}（工作表不存在）`);
        continue;
      }
      const cell = ws.getCell(item.cellRef);
      // 合并区域的从属格写入会被 Excel 拒绝（表现为打开时修复提示）；公式格写入会毁掉公式
      if (cell.isMerged && (cell.master as ExcelJS.Cell)?.address !== cell.address) {
        skipped.push(`${item.fieldKey} @ ${item.sheet}!${item.cellRef}（合并格从属位，请指到主格）`);
        continue;
      }
      if (cell.type === ExcelJS.ValueType.Formula) {
        skipped.push(`${item.fieldKey} @ ${item.sheet}!${item.cellRef}（公式格不覆盖）`);
        continue;
      }
      cell.value = this.coerceValue(value, aiFieldByKey(item.fieldKey)?.type);
      filled += 1;
    }

    const out = await wb.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(out),
      filled,
      // 被权限拦下的项也算「跳过」，前端能直接告诉用户为什么少了这些格
      skipped: [...blocked, ...skipped],
      fileName: fileName.replace(/\.xlsx$/i, '') + '-已填.xlsx',
    };
  }

  /**
   * 行级表格填充（Phase 4）：把数据集的行按用户列映射写进模板的表区。
   *
   * 与单值回填共用权限/范围校验；写值不写公式（以 `= + - @` 开头的文本强制按文本落库），
   * 超出模板空行时插行并复制样式；行数上限 2000，超出截断并在返回里标记。
   */
  async fillTable(
    file: any,
    body: {
      datasetKey?: string;
      sheet?: string;
      headerRow?: number | string;
      startRow?: number | string;
      columns?: unknown;
    },
    ctx: ResolveContext,
    user: any,
  ): Promise<{ buffer: Buffer; fileName: string; filledRows: number; skippedCells: number; truncated: boolean }> {
    const cfg = await this.config();
    ctx = await this.resolveFormScope(ctx, user);
    const { buffer, fileName } = this.assertUpload(file, cfg);

    const datasetKey = String(body?.datasetKey ?? '').trim();
    const def = datasetByKey(datasetKey);
    if (!def || !def.implemented) throw new BadRequestException('数据集不存在或尚未实现');
    // 与 forms/inspect 同一道权限闸：ai:use ≠ 该业务域的读取权限。
    // 否则只有 ai:use 的岗位可以上传空表 + 自选数据集，把 finance/material 等域整表导出。
    if (!this.canReader(user)(def.permission)) {
      throw new ForbiddenException(`没有该数据集的读取权限（需要 ${def.permission}）`);
    }
    const allowedColumns = new Set(datasetColumnsOf(datasetKey));
    if (!allowedColumns.size) throw new BadRequestException('该数据集暂不支持行级填充');

    const sheet = String(body?.sheet ?? '').trim();
    const startRow = Math.max(1, Math.floor(Number(body?.startRow) || 0));
    if (!sheet || !startRow) throw new BadRequestException('缺少工作表或起始行');

    let rawColumns: unknown = body?.columns;
    if (typeof rawColumns === 'string') {
      try {
        rawColumns = JSON.parse(rawColumns);
      } catch {
        throw new BadRequestException('列映射不是合法 JSON');
      }
    }
    if (!Array.isArray(rawColumns) || !rawColumns.length) throw new BadRequestException('缺少列映射');
    if (rawColumns.length > 50) throw new BadRequestException('列映射过多（上限 50 列）');
    const mappings: Array<{ col: number; source: string }> = [];
    for (const raw of rawColumns as any[]) {
      const col = Math.floor(Number(raw?.col) || 0);
      const source = String(raw?.source ?? '').trim();
      if (col < 1) throw new BadRequestException('列映射里的列号不合法');
      if (!allowedColumns.has(source)) throw new BadRequestException(`未知的数据集列：${source}`);
      if (!mappings.some((m) => m.col === col)) mappings.push({ col, source });
    }

    const { wb } = await this.readCells(buffer);
    const ws = wb.getWorksheet(sheet);
    if (!ws) throw new BadRequestException(`工作表不存在：${sheet}`);

    const projects = (ctx.scope?.projectIds?.length ? ctx.scope.projectIds : [ctx.projectId]).map((id) => ({
      id,
      code: '',
      name: '',
    }));
    const from = parseLocalDay(ctx.period?.from);
    const to = parseLocalDay(ctx.period?.to) ?? new Date();
    const collected = await this.collector.collect(projects, { from, to: endOfDay(to) }, null);
    const fact = collected.datasets.find((d) => d.key === datasetKey);
    if (!fact) throw new BadRequestException('该数据集没有取到数据');

    const MAX_TABLE_ROWS = 2000;
    const rows = fact.rows.slice(0, MAX_TABLE_ROWS);
    const truncated = fact.rows.length > MAX_TABLE_ROWS;
    const templateRow = Math.min(startRow, Math.max(ws.rowCount, startRow));
    const maxCol = Math.max(ws.columnCount, ...mappings.map((m) => m.col));

    let filledRows = 0;
    let skippedCells = 0;
    rows.forEach((row, i) => {
      const target = startRow + i;
      if (target > ws.rowCount) {
        ws.insertRow(target, 1);
        const src = ws.getRow(templateRow);
        for (let c = 1; c <= maxCol; c += 1) {
          const toCell = ws.getCell(target, c);
          const fromCell = src.getCell(c);
          toCell.style = { ...(fromCell.style as any) };
          toCell.numFmt = fromCell.numFmt;
        }
      }
      for (const m of mappings) {
        const value = row[m.source];
        if (value === null || value === undefined || value === '') {
          skippedCells += 1;
          continue;
        }
        const cell = ws.getCell(target, m.col);
        if (cell.isMerged && (cell.master as ExcelJS.Cell)?.address !== cell.address) {
          skippedCells += 1;
          continue;
        }
        cell.value =
          typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : (value as any);
      }
      filledRows += 1;
    });

    const out = await wb.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(out),
      fileName: fileName.replace(/\.xlsx$/i, '') + '-已填表.xlsx',
      filledRows,
      skippedCells,
      truncated,
    };
  }

  /** 单位/百分比按数值写入（文本形式会被 Excel 标绿三角、也让下游公式失效） */
  private coerceValue(value: string, type?: AiFieldDef['type']): string | number | Date {
    if (type === 'money' || type === 'number' || type === 'percent') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      return value;
    }
    if (type === 'date') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (m) {
        /**
         * 用 **UTC 零点**构造：ExcelJS 落盘时取的是 Date 的 UTC 时刻写成 Excel 序列值，
         * 若用本地零点（如东八区 `2026-08-01 00:00+08`），存进文件就变成 `2026-07-31 16:00`，
         * 打开后显示成前一天。用 `Date.UTC(y, m-1, d)` 才能落成 2026-08-01 00:00。
         */
        return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      }
      return value;
    }
    return value;
  }

  /** 校验前端回传的映射（白名单：字段必须在目录内、坐标必须合法、条数有上限） */
  private parseMapping(raw: unknown): AiFillItem[] {
    let list: unknown = raw;
    if (typeof raw === 'string') {
      try {
        list = JSON.parse(raw);
      } catch {
        throw new BadRequestException('映射数据不是合法 JSON');
      }
    }
    if (!Array.isArray(list)) throw new BadRequestException('缺少映射数据');
    if (!list.length) throw new BadRequestException('映射为空，没有可回填的内容');
    if (list.length > MAX_MAPPING) {
      throw new BadRequestException(`单次最多回填 ${MAX_MAPPING} 项，请拆分文件`);
    }

    const out: AiFillItem[] = [];
    for (const item of list) {
      const o = item as Record<string, unknown>;
      const fieldKey = String(o?.fieldKey ?? '').trim();
      const sheet = String(o?.sheet ?? '').trim();
      const cellRef = String(o?.cellRef ?? '').trim().toUpperCase();
      if (!aiFieldByKey(fieldKey)) throw new BadRequestException(`未知字段：${fieldKey}`);
      if (!sheet) throw new BadRequestException('缺少工作表名');
      if (!CELL_REF_RE.test(cellRef)) throw new BadRequestException(`单元格坐标非法：${cellRef}`);
      out.push({ sheet, cellRef, fieldKey });
    }
    return out;
  }

  /** 供控制器设置下载头 */
  readonly xlsxMime = XLSX_MIME;
  readonly docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}


