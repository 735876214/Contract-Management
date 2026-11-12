import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertPermission } from '../../../common/utils/assert-permission';
import type { JwtUser } from '../../../common/decorators/user.decorator';
import { datasetByKey, filterDatasets, limitDatasets, DEFAULT_DATASET_KEYS, MAX_DATASETS } from './dataset-registry';
import { parseIntentRules } from '../intent/intent-rules';
import type { AiAnalyticsPlanInput } from '../intent/intent.types';
import type { AiAnalyticsIntent, AiAnalyticsPlanResult } from './analytics.types';
import { DatasetCollector } from './dataset-collector.service';
import { AnalyticsStore } from './analytics-store.service';
import { ReportService } from '../report.service';
import {
  analyticsFactNumbers,
  analyticsFactsToMarkdown,
  analyticsTitle,
  buildAnalyticsFacts,
} from './dataset-facts';
import { compareRange, localDayKey, rangeLabel, resolvePresetPeriod } from '../common/period';
import { AI_SECTION_TITLES } from './analytics.types';

export interface AnalyticsReportInput extends AiAnalyticsPlanInput {
  /** 可改标题（≤60 字）；不传则自动生成「范围 + 期间 + 类型」 */
  title?: string;
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
  async plan(body: AiAnalyticsPlanInput, projectId: string, user: JwtUser): Promise<AiAnalyticsPlanResult> {
    assertPermission(user, 'ai:use', '生成经营数据报告需要「使用 AI 助手」权限');
    const can = this.can(user);
    const allowed = await this.allowedProjects(user);
    const parsed = parseIntentRules(body ?? {});
    const warnings = [...parsed.warnings];

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
      source: 'rules',
    };
  }

  private scopeLabel(intent: AiAnalyticsIntent, projects: Array<{ code: string; name: string }>): string {
    if (intent.scope.mode === 'all') return `全部项目（${projects.length} 个）`;
    if (intent.scope.mode === 'selected') return `已选 ${projects.length} 个项目`;
    return projects[0] ? `${projects[0].code} ${projects[0].name}` : '当前项目';
  }

  /**
   * 确定性报告（Phase 2，不调模型）：取数 → 事实包 → Markdown → 落库。
   * 事实 JSON 落库与返回都做**瘦身**（每数据集最多 200 行），完整明细留给工作簿（Phase 4）。
   */
  async report(body: AnalyticsReportInput, projectId: string, user: JwtUser) {
    const plan = await this.plan(body || {}, projectId, user);
    const intent = plan.intent;
    const now = new Date();
    const range = resolvePresetPeriod(intent.period.preset, now, {
      from: intent.period.from,
      to: intent.period.to,
    });
    if (!range) throw new BadRequestException('期间无法解析：自定义期间需要合法的开始与结束日期');
    const cmpRange = compareRange(range, intent.compare);

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
      datasets: collected.datasets,
      warnings: [...plan.warnings, ...collected.warnings],
      asOf: collected.asOf,
      generatedAt: now.toISOString(),
    });

    const markdown = analyticsFactsToMarkdown(facts);
    const title = String(body?.title || analyticsTitle(intent.reportKind, scopeLabel, periodLabel)).slice(0, 60);
    const factsForStore = {
      ...facts,
      datasets: facts.datasets.map((d) => ({ ...d, rows: d.rows.slice(0, 200) })),
    };
    const warnings = [...facts.warnings];
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
        scopeMode: intent.scope.mode,
        projectCount: plan.projects.length,
        periodFrom: range.from,
        periodTo: range.to,
        periodLabel,
        compareMode: intent.compare,
        narrative: false,
        source: 'template',
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
      discardedNumbers: [] as string[],
      warnings: [...new Set(warnings)],
      source: 'template' as const,
      usage: null,
      factNumbers: analyticsFactNumbers(facts),
    };
  }

  list(user: JwtUser, query: any) {
    return this.store.list(user, query || {});
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
