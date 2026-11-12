import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertPermission } from '../../../common/utils/assert-permission';
import { StorageService } from '../../../common/services/storage.service';
import { StyledExcelService } from '../../../common/services/styled-excel.service';
import type { JwtUser } from '../../../common/decorators/user.decorator';
import { datasetByKey, filterDatasets, limitDatasets, DEFAULT_DATASET_KEYS, MAX_DATASETS } from './dataset-registry';
import { parseIntentRules, normalizeModelIntent, type ModelIntentPatch } from '../intent/intent-rules';
import type { AiAnalyticsPlanInput } from '../intent/intent.types';
import { IntentService } from '../intent/intent.service';
import { AiSettingService } from '../ai-setting.service';
import { AiQuota } from '../ai-quota';
import { chatJson, LlmError } from '../llm-client';
import { aiModelFor } from '../ai-config';
import type { AiAnalyticsIntent, AiAnalyticsPlanResult } from './analytics.types';
import { DatasetCollector } from './dataset-collector.service';
import { AnalyticsStore } from './analytics-store.service';
import { ReportService } from '../report.service';
import {
  analyticsFactNumbers,
  analyticsFactsToMarkdown,
  analyticsTitle,
  buildAnalyticsFacts,
  buildNarratedReport,
} from './dataset-facts';
import { buildAnalyticsNarrativeMessages } from './analytics-prompt';
import { buildAnalyticsWorkbookModel } from './workbook-builder';
import { compareRange, localDayKey, rangeLabel, resolvePresetPeriod, type DayRange } from '../common/period';
import { AI_SECTION_TITLES } from './analytics.types';

export interface AnalyticsReportInput extends AiAnalyticsPlanInput {
  /** 可改标题（≤60 字）；不传则自动生成「范围 + 期间 + 类型」 */
  title?: string;
  /** 是否调模型写叙述（默认 true；AI 未配置时自动降级为确定性报告） */
  narrative?: boolean;
}

/** 项目集合上限：显式多选/全部项目都受它约束（防一次拉爆查询预算） */
const MAX_PROJECTS = 50;

/**
 * AI 经营数据助手 · 编排服务（Phase 1：注册表 + 规则意图）。
 *
 * Phase 1 只做两件事：`GET /datasets` 的权限过滤注册表、`POST /plan` 的规则意图解析与合并。
 * 取数（DatasetCollector）与报告/工作簿在 Phase 2+ 接入；本服务不查业务表，只查项目成员关系。
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private prisma: PrismaClient,
    private collector: DatasetCollector,
    private store: AnalyticsStore,
    private reportService: ReportService,
    private setting: AiSettingService,
    private quota: AiQuota,
    private intent: IntentService,
    private storage: StorageService,
    private styled: StyledExcelService,
  ) {}

  /** 权限判据与 `ai.service.ts` 的 `canReader` 同约定：超管恒 true */
  private can(user: JwtUser): (code: string) => boolean {
    return (code: string) => !!user?.isSuperAdmin || (user?.permissions ?? []).includes(code);
  }

  /** 用户有权限的项目（超管不受成员关系限制） */
  private async allowedProjects(user: JwtUser): Promise<Array<{ id: string; code: string; name: string; nameAbbr: string | null }>> {
    const where: any = {};
    if (!user?.isSuperAdmin) {
      if (!user?.userId) throw new BadRequestException('缺少用户身份，无法校验项目权限');
      where.members = { some: { userId: user.userId } };
    }
    return this.prisma.project.findMany({
      where,
      select: { id: true, code: true, name: true, nameAbbr: true },
      orderBy: { code: 'asc' },
      take: 500,
    });
  }

  /** 注册表（只返回已实现且用户有权限的条目；无权限的单独列出供前端提示） */
  async listDatasets(user: JwtUser) {
    const can = this.can(user);
    const { visible, denied } = filterDatasets(can);
    return {
      datasets: visible.map((d) => ({
        key: d.key,
        label: d.label,
        desc: d.desc,
        permission: d.permission,
        periodField: d.periodField,
        reportSection: d.reportSection,
        defaultSelected: !!d.defaultSelected,
      })),
      deniedDatasets: denied.map((d) => d.key),
      crossProjectAllowed: can('dashboard:view'),
      maxDatasets: MAX_DATASETS,
      defaultKeys: DEFAULT_DATASET_KEYS.filter((k) => visible.some((d) => d.key === k)),
    };
  }

  /**
   * 规则意图 + 结构化覆盖 + 权限收口。
   *
   * 与 `ScmService` 同款 IDOR 防护：项目集合来自客户端参数时必须按 `ProjectMember` 收口；
   * 跨项目（全部项目或 >1 个）额外要求 `dashboard:view`。
   */
  async plan(
    body: AiAnalyticsPlanInput,
    projectId: string,
    user: JwtUser,
    opts: { consumeQuota?: boolean; useIntentLlm?: boolean } = {},
  ): Promise<AiAnalyticsPlanResult> {
    assertPermission(user, 'ai:use', '生成经营数据报告需要「使用 AI 助手」权限');
    const can = this.can(user);
    const allowed = await this.allowedProjects(user);
    const warnings: string[] = [];

    // ---- Phase 3：有文本且 AI 启用时，先让模型做意图（只输出枚举）；失败回落规则 ----
    let modelPatch: ModelIntentPatch | null = null;
    let source: 'rules' | 'llm' = 'rules';
    const text = String(body?.text ?? '').trim();
    if (text && opts.useIntentLlm !== false) {
      const cfg = await this.setting.resolve();
      if (cfg.enabled) {
        const userId = user?.userId || user?.username || 'anonymous';
        const consume = opts.consumeQuota !== false;
        if (consume) this.quota.consume(userId, cfg.hourlyLimitPerUser);
        try {
          const r = await this.intent.parse(cfg, text, allowed.map((p) => p.name));
          const norm = normalizeModelIntent(r.raw);
          modelPatch = norm.patch;
          warnings.push(...norm.warnings);
          source = 'llm';
        } catch (e) {
          if (consume) this.quota.refund(userId);
          const msg = e instanceof LlmError ? e.message : String((e as any)?.message || e);
          // 失败不空窗：按规则解析继续，用户拿到的是确定性结果 + 一句原因
          warnings.push(`AI 意图解析失败，已按规则解析：${msg}`);
        }
      }
    }

    const parsed = parseIntentRules(body ?? {}, modelPatch);
    warnings.push(...parsed.warnings);

    let intent: AiAnalyticsIntent = parsed.intent;
    const scope = intent.scope.mode;
    let projects = allowed;

    if (scope === 'current') {
      const cur = allowed.find((p) => p.id === projectId);
      if (!cur) throw new ForbiddenException('当前项目不在你的成员范围内');
      projects = [cur];
    } else if (scope === 'selected') {
      const wantedIds = Array.isArray(body?.scope?.projectIds) ? [...new Set(body!.scope!.projectIds!.filter(Boolean))] : [];
      const mentions = (intent.scope.mentions ?? []).filter(Boolean);
      const allowedIds = new Set(allowed.map((p) => p.id));
      const unmatchedIds = wantedIds.filter((id) => !allowedIds.has(id));
      if (unmatchedIds.length) warnings.push(`忽略 ${unmatchedIds.length} 个无权或未知的项目`);
      const byId = allowed.filter((p) => wantedIds.includes(p.id));
      const byMention = mentions.length
        ? allowed.filter((p) =>
            mentions.some((m) => p.name.includes(m) || (p.nameAbbr ?? '').includes(m) || p.code.includes(m)),
          )
        : [];
      const merged: typeof allowed = [];
      for (const p of [...byId, ...byMention]) {
        if (!merged.some((x) => x.id === p.id)) merged.push(p);
      }
      if (!merged.length) {
        throw new BadRequestException('没有匹配到有权限的项目：请先在项目选择器里选择项目，或改用「全部项目」');
      }
      projects = merged;
      intent = { ...intent, scope: { mode: 'selected', mentions: merged.map((p) => p.name) } };
    } else {
      projects = allowed;
      if (!projects.length) throw new ForbiddenException('你的成员范围内没有项目，无法生成跨项目报告');
    }

    if (projects.length > MAX_PROJECTS) {
      projects = projects.slice(0, MAX_PROJECTS);
      warnings.push(`项目数超过 ${MAX_PROJECTS} 个，已按编号取前 ${MAX_PROJECTS} 个`);
    }

    const crossProject = scope === 'all' || projects.length > 1;
    if (crossProject) {
      assertPermission(
        user,
        'dashboard:view',
        '汇总多个项目的经营数据，需要「统计报表-查看」权限',
      );
    }

    // ---- 数据集：只保留「已实现 + 有权限」；显式点选与文本命中共用同一过滤 ----
    const { visible, denied } = filterDatasets(can);
    const visibleKeys = new Set(visible.map((d) => d.key));
    const deniedKeys = new Set(denied.map((d) => d.key));
    const unknown = new Set(parsed.unknownDatasets);
    const requestedDenied = intent.datasets.filter((k) => deniedKeys.has(k));
    const kept: string[] = [];
    for (const key of intent.datasets) {
      if (visibleKeys.has(key)) {
        if (!kept.includes(key)) kept.push(key);
        continue;
      }
      if (deniedKeys.has(key)) continue;
      // 未登记或已登记未实现：对用户都等价于「选不到」，进 unknown 并提示
      unknown.add(key);
    }
    if (requestedDenied.length) warnings.push(`以下数据集无查看权限：${requestedDenied.join('、')}`);

    let finalKeys = kept;
    if (!finalKeys.length) {
      const defaults = DEFAULT_DATASET_KEYS.filter((k) => visibleKeys.has(k));
      if (!defaults.length) {
        throw new BadRequestException('没有可用的数据集：缺少所选数据集的查看权限');
      }
      finalKeys = [...defaults];
      warnings.push('所选数据集均不可用，已回落到默认数据集');
    }
    const limited = limitDatasets(finalKeys, MAX_DATASETS);
    if (limited.truncated > 0) warnings.push(`数据集超过 ${MAX_DATASETS} 个，已截断 ${limited.truncated} 个`);
    if (unknown.size) warnings.push(`忽略未知数据集：${[...unknown].join('、')}`);

    intent = { ...intent, datasets: limited.keys };

    return {
      intent,
      warnings: [...new Set(warnings)],
      unknownTerms: parsed.unknownTerms,
      unknownDatasets: [...unknown],
      deniedDatasets: requestedDenied,
      projects: projects.map((p) => ({ id: p.id, code: p.code, name: p.name })),
      source,
    };
  }

  private scopeLabel(intent: AiAnalyticsIntent, projects: Array<{ code: string; name: string }>): string {
    if (intent.scope.mode === 'all') return `全部项目（${projects.length} 个）`;
    if (intent.scope.mode === 'selected') return `已选 ${projects.length} 个项目`;
    return projects[0] ? `${projects[0].code} ${projects[0].name}` : '当前项目';
  }

  /** 报告与工作簿共用：取数 → 事实包（同一份数字，不允许两条链路各算一遍） */
  private async prepareFacts(plan: AiAnalyticsPlanResult, range: DayRange, cmpRange: DayRange | null) {
    const intent = plan.intent;
    const collected = await this.collector.collect(plan.projects, range, cmpRange);
    const scopeLabel = this.scopeLabel(intent, plan.projects);
    const periodLabel = rangeLabel(range);
    const facts = buildAnalyticsFacts({
      scopeLabel,
      projects: plan.projects,
      period: {
        from: range.from ? localDayKey(range.from) : null,
        to: localDayKey(range.to),
        label: periodLabel,
        preset: intent.period.preset,
      },
      compareMode: intent.compare,
      comparePeriod:
        cmpRange && intent.compare !== 'none'
          ? {
              from: cmpRange.from ? localDayKey(cmpRange.from) : null,
              to: localDayKey(cmpRange.to),
              label: rangeLabel(cmpRange),
              mode: intent.compare,
            }
          : null,
      totals: collected.totals,
      compareTotals: collected.compareTotals,
      byProject: collected.byProject,
      // 只保留用户选择的数据集（采集器按全量构建，报告/工作簿/历史都只该出现所选）
      datasets: collected.datasets.filter((d) => intent.datasets.includes(d.key)),
      warnings: [...plan.warnings, ...collected.warnings],
      asOf: collected.asOf,
      generatedAt: new Date().toISOString(),
    });
    return { facts, scopeLabel, periodLabel };
  }

  /**
   * 确定性报告（Phase 2，不调模型）：取数 → 事实包 → Markdown → 落库。
   * 事实 JSON 落库与返回都做**瘦身**（每数据集最多 200 行），完整明细留给工作簿（Phase 4）。
   */
  async report(body: AnalyticsReportInput, projectId: string, user: JwtUser) {
    const cfg = await this.setting.resolve();
    const wantsNarrative = cfg.enabled && body?.narrative !== false;
    const userId = user?.userId || user?.username || 'anonymous';
    if (wantsNarrative) this.quota.consume(userId, cfg.hourlyLimitPerUser);
    let plan: AiAnalyticsPlanResult;
    try {
      plan = await this.plan(body || {}, projectId, user, { consumeQuota: false });
    } catch (e) {
      if (wantsNarrative) this.quota.refund(userId);
      throw e;
    }
    const intent = plan.intent;
    const now = new Date();
    const range = resolvePresetPeriod(intent.period.preset, now, {
      from: intent.period.from,
      to: intent.period.to,
    });
    if (!range) throw new BadRequestException('期间无法解析：自定义期间需要合法的开始与结束日期');
    const cmpRange = compareRange(range, intent.compare);

    const { facts, scopeLabel, periodLabel } = await this.prepareFacts(plan, range, cmpRange);

    const warnings = [...facts.warnings];
    let markdown = analyticsFactsToMarkdown(facts);
    let discardedNumbers: string[] = [];
    let reportSource: 'template' | 'llm' = 'template';
    let usage: { promptTokens?: number; completionTokens?: number } | null = null;

    // Phase 3：模型只写段落；数字对账失败 → 整段叙述丢弃，仍返回确定性报告
    if (wantsNarrative) {
      try {
        const res = await chatJson(
          globalThis.fetch as any,
          {
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: aiModelFor(cfg, 'report'),
            timeoutMs: Math.max(cfg.timeoutMs, 90000),
            temperature: 0.3,
            maxTokens: cfg.maxTokens,
          },
          buildAnalyticsNarrativeMessages(facts, intent.notes),
          true,
        );
        const narrated = buildNarratedReport(facts, res.data);
        markdown = narrated.markdown;
        discardedNumbers = narrated.discarded;
        warnings.push(...narrated.warnings);
        if (narrated.accepted) reportSource = 'llm';
        usage = res.usage ?? null;
      } catch (e) {
        // 意图与叙述共享一次配额：意图也没成功消费时退还，否则保留（已有一次成功调用）
        if (plan.source === 'rules') this.quota.refund(userId);
        const msg = e instanceof LlmError ? e.message : String((e as any)?.message || e);
        warnings.push(`AI 叙述失败，已输出确定性报告：${msg}`);
      }
    }
    const title = String(body?.title || analyticsTitle(intent.reportKind, scopeLabel, periodLabel)).slice(0, 60);
    const factsForStore = {
      ...facts,
      datasets: facts.datasets.map((d) => ({ ...d, rows: d.rows.slice(0, 200) })),
    };
    let id: string | null = null;
    let persisted = true;
    try {
      const row = await this.store.create({
        projectId,
        createdBy: user?.userId ?? null,
        createdByName: user?.realName ?? user?.username ?? null,
        title,
        rawText: intent.rawText ?? null,
        intentJson: intent,
        scopeJson: facts.scope,
        datasetKeys: intent.datasets,
        factsJson: factsForStore,
        warningsJson: warnings,
        unknownNumbersJson: [],
        discardedNumbersJson: discardedNumbers,
        scopeMode: intent.scope.mode,
        projectCount: plan.projects.length,
        periodFrom: range.from,
        periodTo: range.to,
        periodLabel,
        compareMode: intent.compare,
        narrative: reportSource === 'llm',
        source: reportSource,
        markdown,
        hasReport: true,
      });
      id = row.id;
    } catch {
      persisted = false;
      warnings.push('报告已生成，但历史记录保存失败（本次结果仍可查看；请稍后重试或联系管理员）');
    }

    const sectionIds = [...new Set(facts.datasets.map((d) => d.section))];
    return {
      id,
      persisted,
      title,
      intent,
      scope: facts.scope,
      period: facts.period,
      compareMode: facts.compareMode,
      comparePeriod: facts.comparePeriod,
      sections: sectionIds.map((sid) => ({ id: sid, title: AI_SECTION_TITLES[sid] })),
      markdown,
      facts: factsForStore,
      unknownNumbers: [] as string[],
      discardedNumbers,
      warnings: [...new Set(warnings)],
      source: reportSource,
      usage,
      factNumbers: analyticsFactNumbers(facts),
    };
  }

  list(user: JwtUser, query: any) {
    return this.store.list(user, query || {});
  }

  /**
   * 多 sheet 工作簿（确定性、不调模型、不扣配额）：与报告共用同一份事实包。
   * `reportId` 给了就挂到已有报告记录上；否则新建一条「仅表格」记录。
   */
  async workbook(
    body: AnalyticsReportInput & { reportId?: string },
    projectId: string,
    user: JwtUser,
  ) {
    assertPermission(user, 'ai:use', '生成经营数据表格需要「使用 AI 助手」权限');
    const plan = await this.plan(body || {}, projectId, user, { consumeQuota: false, useIntentLlm: false });
    const now = new Date();
    const range = resolvePresetPeriod(plan.intent.period.preset, now, {
      from: plan.intent.period.from,
      to: plan.intent.period.to,
    });
    if (!range) throw new BadRequestException('期间无法解析：自定义期间需要合法的开始与结束日期');
    const cmpRange = compareRange(range, plan.intent.compare);
    const { facts, scopeLabel, periodLabel } = await this.prepareFacts(plan, range, cmpRange);
    const model = buildAnalyticsWorkbookModel(facts);
    const title = String(body?.title || analyticsTitle(plan.intent.reportKind, scopeLabel, periodLabel)).slice(0, 60);

    const buffer = await this.styled.withWorkbook(async (wb) => {
      for (const sheet of model) {
        const ws = wb.addWorksheet(sheet.name);
        let headerRow = 1;
        if (sheet.note) {
          const noteCell = ws.getCell(1, 1);
          noteCell.value = sheet.note;
          noteCell.font = { italic: true, size: 10, color: { argb: 'FF666666' } };
          if (sheet.columns.length > 1) ws.mergeCells(1, 1, 1, sheet.columns.length);
          headerRow = 2;
        }
        ws.getRow(headerRow).values = sheet.columns;
        ws.getRow(headerRow).font = { bold: true };
        ws.views = [{ state: 'frozen', ySplit: headerRow }];
        sheet.columns.forEach((col, i) => {
          ws.getColumn(i + 1).width = Math.min(32, Math.max(10, col.length * 2 + 6));
        });
        if (!sheet.rows.length) {
          ws.getCell(headerRow + 1, 1).value = '无数据';
        }
        sheet.rows.forEach((row, r) => {
          sheet.columns.forEach((col, c) => {
            const raw = row[col];
            // 数据一律写字符串/数值，不生成公式（以 = + - @ 开头的文本强制按文本落库）
            const value =
              typeof raw === 'string' && /^[=+\-@]/.test(raw) ? `'${raw}` : (raw as any);
            ws.getCell(headerRow + 1 + r, c + 1).value = value ?? '';
          });
        });
      }
    });

    const fileName = `${title}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    const saved = await this.storage.save(buffer, { sub: `ai-analytics/${projectId}`, ext: '.xlsx', name: fileName });
    const warnings = [...facts.warnings];
    const factsForStore = {
      ...facts,
      datasets: facts.datasets.map((d) => ({ ...d, rows: d.rows.slice(0, 200) })),
    };
    let id: string;
    try {
      if (body?.reportId) {
        await this.store.attachWorkbook(body.reportId, user, { key: saved.key, name: fileName, size: saved.size });
        id = body.reportId;
      } else {
        const row = await this.store.create({
          projectId,
          createdBy: user?.userId ?? null,
          createdByName: user?.realName ?? user?.username ?? null,
          title,
          rawText: plan.intent.rawText ?? null,
          intentJson: plan.intent,
          scopeJson: facts.scope,
          datasetKeys: plan.intent.datasets,
          factsJson: factsForStore,
          warningsJson: warnings,
          scopeMode: plan.intent.scope.mode,
          projectCount: plan.projects.length,
          periodFrom: range.from,
          periodTo: range.to,
          periodLabel,
          compareMode: plan.intent.compare,
          narrative: false,
          source: 'template',
          markdown: null,
          hasReport: false,
          workbookKey: saved.key,
          workbookName: fileName,
          workbookSize: saved.size,
          hasWorkbook: true,
        });
        id = row.id;
      }
    } catch {
      // DB 失败时把刚写的文件删掉，避免留下无主孤儿
      await this.storage.remove(saved.key).catch(() => undefined);
      throw new InternalServerErrorException('工作簿已生成但记录保存失败，已回滚文件，请重试');
    }

    return {
      id,
      fileName,
      size: saved.size,
      sheets: model.map((s) => s.name),
      warnings,
      reportId: body?.reportId ?? null,
    };
  }

  /** 下载存档工作簿（只按记录 key 读取；不接受客户端传入路径） */
  async workbookFile(id: string, user: JwtUser) {
    const row = await this.store.detail(id, user);
    if (!row.workbookKey) throw new NotFoundException('该记录没有表格文件');
    const buffer = await this.storage.read(row.workbookKey);
    return { buffer, fileName: row.workbookName || 'analytics.xlsx' };
  }

  detail(id: string, user: JwtUser) {
    return this.store.detail(id, user);
  }

  remove(id: string, user: JwtUser) {
    return this.store.remove(id, user);
  }

  /** 用**存档 Markdown** 重新排版导出，不重新取数 */
  async exportRecord(id: string, format: string | undefined, user: JwtUser) {
    const row = await this.store.detail(id, user);
    const markdown = String(row.markdown ?? '').trim();
    if (!markdown) throw new NotFoundException('该记录没有报告正文，无法导出');
    const isPdf = String(format || 'docx').toLowerCase() === 'pdf';
    return isPdf
      ? this.reportService.exportPdf({ markdown, title: row.title })
      : this.reportService.exportDocx({ markdown, title: row.title });
  }
}
