import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertPermission } from '../../../common/utils/assert-permission.ts';
import { StorageService } from '../../../common/services/storage.service.ts';
import { projectScopedSub } from '../../../common/utils/storage-keys.ts';
import { StyledExcelService } from '../../../common/services/styled-excel.service.ts';
import type { JwtUser } from '../../../common/decorators/user.decorator.ts';
import { filterDatasets, limitDatasets, DEFAULT_DATASET_KEYS, MAX_DATASETS } from '../../ai-core/dataset/dataset-registry.ts';
import { parseIntentRules, normalizeModelIntent, type ModelIntentPatch } from '../intent/intent-rules.ts';
import type { AiAnalyticsPlanInput } from '../intent/intent.types.ts';
import { IntentService } from '../intent/intent.service.ts';
import { AiSettingService } from '../../ai-core/ai-setting.service.ts';
import { AiQuota } from '../../ai-core/ai-quota.ts';
import { chatJson, chatText, LlmError } from '../../ai-core/llm-client.ts';
import { aiModelFor } from '../../ai-core/ai-config.ts';
import type { AiAnalyticsFacts, AiAnalyticsIntent, AiAnalyticsPlanResult } from '../../ai-core/dataset/analytics.types.ts';
import { DatasetCollector } from './dataset-collector.service.ts';
import { AnalyticsStore } from './analytics-store.service.ts';
import { ReportService } from '../report.service.ts';
import { analyticsFactNumbers, analyticsFactsToMarkdown, analyticsTitle, buildAnalyticsFacts, buildNarratedReport, reportPresentation } from './dataset-facts.ts';
import { buildAnalyticsNarrativeMessages } from './analytics-prompt.ts';
import { buildChatAnswer, buildChatAnswerMessages, chatFallbackAnswer } from './chat-answer.ts';
import { buildAnalyticsWorkbookModel } from './workbook-builder.ts';
import { compareRange, localDayKey, rangeLabel, resolvePresetPeriod } from '../../ai-core/common/period.ts';
import type { DayRange } from '../../ai-core/common/period.ts';
import { projectScopeWhere } from '../../ai-core/common/project-scope.ts';
import { loadAiScopedProjects } from '../../../query';
import { AI_SECTION_TITLES } from '../../ai-core/dataset/analytics.types.ts';

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
    return loadAiScopedProjects(this.prisma, projectScopeWhere(user));
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
      if (wantedIds.length > MAX_PROJECTS) {
        throw new BadRequestException(`显式选择的项目不能超过 ${MAX_PROJECTS} 个`);
      }
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
      if (merged.length > MAX_PROJECTS) {
        throw new BadRequestException(`匹配到的项目超过 ${MAX_PROJECTS} 个，请缩小范围`);
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
    const collected = await this.collector.collect(plan.projects, range, cmpRange, plan.intent.datasets);
    const scopeLabel = this.scopeLabel(intent, plan.projects);
    const periodLabel = rangeLabel(range);
    // 参照期无数据 → 对比期置 null（计划 §2.3：显示 `-`，不当作下降 100%）
    const ref = collected.compareTotals;
    const refHasData =
      !!ref &&
      (ref.contractCount > 0 ||
        ref.settledYuan !== 0 ||
        ref.paidYuan !== 0 ||
        ref.invoicedYuan !== 0 ||
        ref.dailyReports > 0 ||
        ref.procurementTasks > 0);
    const effectiveCompare = cmpRange && intent.compare !== 'none' && refHasData ? cmpRange : null;
    const facts = buildAnalyticsFacts({
      scopeLabel,
      scopeMode: intent.scope.mode,
      projects: plan.projects,
      period: {
        from: range.from ? localDayKey(range.from) : null,
        to: localDayKey(range.to),
        label: periodLabel,
        preset: intent.period.preset,
      },
      compareMode: effectiveCompare ? intent.compare : 'none',
      comparePeriod: effectiveCompare
        ? {
            from: effectiveCompare.from ? localDayKey(effectiveCompare.from) : null,
            to: localDayKey(effectiveCompare.to),
            label: rangeLabel(effectiveCompare),
            mode: intent.compare as 'mom' | 'yoy',
          }
        : null,
      totals: collected.totals,
      compareTotals: effectiveCompare ? collected.compareTotals : null,
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
  /**
   * **AI 问数（P3-A）**：一次问答。
   *
   * 复用 `report()` 的全部地基——`plan()`（意图+权限+项目解析）、`prepareFacts()`（程序算数）、
   * `auditNumbers`（数字回查）、`recordPayload`（留痕）；只把「产出形态」换成一段回答：
   * - 数字仍**只由** `DatasetCollector` 算（模型不许计算）；
   * - 回答仍要**逐条对账**（`buildChatAnswer`），对不上就整段丢弃、退回事实摘要；
   * - 留痕复用 `AiAnalyticsReport`，`answerMode='chat'`（不新开表，理由见该字段注释）。
   *
   * 为什么不并进 `report()`：两者配额语义与失败兜底不同——报告失败要退回确定性报告（仍有产物），
   * 问答失败要退回事实摘要并退还配额；硬揉成一个方法会让两条路径的分支互相污染。
   */
  async ask(body: AiAnalyticsPlanInput, projectId: string, user: JwtUser) {
    assertPermission(user, 'ai:use', '使用 AI 问数需要「使用 AI 助手」权限');
    const question = String(body?.text ?? '').trim();
    if (!question) throw new BadRequestException('请输入问题');
    if (question.length > 2000) throw new BadRequestException('问题过长（上限 2000 字）');

    const cfg = await this.setting.resolve();
    if (!cfg.enabled) {
      throw new BadRequestException('AI 未启用：请先在「系统管理 → AI 信息登记」配置上游地址与密钥');
    }
    const userId = user?.userId || user?.username || 'anonymous';
    // 一次问答 = 最多两次上游调用（意图 + 回答），配额按「一次问答占一次」计（与 report 同口径）
    this.quota.consume(userId, cfg.hourlyLimitPerUser);

    let plan: AiAnalyticsPlanResult;
    let range: DayRange | null;
    let cmpRange: DayRange | null;
    try {
      // 问数默认「当前项目」（管理者问数基本都带项目上下文）；显式传 scope 时以调用方为准
      plan = await this.plan(
        { ...(body || {}), text: question, scope: { mode: 'current', ...((body || {}).scope ?? {}) } },
        projectId,
        user,
        { consumeQuota: false },
      );
      range = resolvePresetPeriod(plan.intent.period.preset, new Date(), {
        from: plan.intent.period.from,
        to: plan.intent.period.to,
      });
      if (!range) throw new BadRequestException('期间无法解析：自定义期间需要合法的开始与结束日期');
      cmpRange = compareRange(range, plan.intent.compare);
    } catch (e) {
      this.quota.refund(userId);
      throw e;
    }

    const { facts, scopeLabel, periodLabel } = await this.prepareFacts(plan, range, cmpRange);
    const warnings = [...facts.warnings];
    let answer = '';
    let discarded: string[] = [];
    let accepted = false;
    let source: 'template' | 'llm' = 'template';
    let usage: { promptTokens?: number; completionTokens?: number } | null = null;

    try {
      const res = await chatText(
        globalThis.fetch as any,
        {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          // 问答沿用 `report` 用途的模型：输出短、但要能对上数字，与报告同一档最省心。
          // 将来若要单独调优，加一个 `chat` 用途即可（ai-config 的用途体系是现成的）。
          model: aiModelFor(cfg, 'report'),
          timeoutMs: Math.min(Math.max(cfg.timeoutMs, 60000), 120000),
          temperature: 0.2,
          maxTokens: Math.min(cfg.maxTokens, 1200),
        },
        buildChatAnswerMessages({ facts, question, scopeLabel, periodLabel }),
      );
      const built = buildChatAnswer(facts, res.text, question);
      answer = built.answer;
      discarded = built.discarded;
      accepted = built.accepted;
      warnings.push(...built.warnings);
      usage = res.usage ?? null;
      if (accepted) source = 'llm';
      // 模型回答被整段丢弃 → 与 report 同口径退还配额（用户拿到的仍是确定性事实摘要）
      else this.quota.refund(userId);
    } catch (e) {
      this.quota.refund(userId);
      const msg = e instanceof LlmError ? e.message : String((e as any)?.message || e);
      answer = chatFallbackAnswer(facts, `AI 回答失败，以下是本期间的事实汇总：${msg}`);
      warnings.push(`AI 回答失败：${msg}`);
    }

    const title = question.slice(0, 60);
    const factsForStore = {
      ...facts,
      datasets: facts.datasets.map((d) => ({ ...d, rows: d.rows.slice(0, 200) })),
    };
    let id: string | null = null;
    let persisted = true;
    try {
      const row = await this.store.create(
        this.recordPayload({
          projectId,
          user,
          plan,
          facts,
          range,
          periodLabel,
          title,
          warnings,
          factsForStore,
          source,
          markdown: answer,
          hasReport: false,
          discardedNumbers: discarded,
          answerMode: 'chat',
        }),
      );
      id = row.id;
    } catch {
      persisted = false;
      warnings.push('回答已生成，但历史记录保存失败（本次结果仍可查看；请稍后重试或联系管理员）');
    }

    return {
      id,
      persisted,
      question,
      answer,
      accepted,
      discardedNumbers: discarded,
      scope: facts.scope,
      period: facts.period,
      scopeLabel,
      periodLabel,
      datasetKeys: plan.intent.datasets,
      datasets: facts.datasets.map((d) => ({ section: d.section, label: d.label, rowCount: d.rows.length })),
      source,
      usage,
      warnings: [...new Set(warnings)],
      factNumbers: analyticsFactNumbers(facts),
    };
  }

  /** 记录列表（问答历史走 `answerMode=chat` 过滤，与报告历史共用一张表与一套可见性规则） */
  listRecords(user: JwtUser, query: any) {
    return this.store.list(user, query || {});
  }

  /** 单条记录详情（本人或超管；非创建人 404，不泄露存在性） */
  getRecord(id: string, user: JwtUser) {
    return this.store.detail(id, user);
  }
  async report(body: AnalyticsReportInput, projectId: string, user: JwtUser) {
    const cfg = await this.setting.resolve();
    const userId = user?.userId || user?.username || 'anonymous';
    const hasText = Boolean(String(body?.text ?? '').trim());
    const wantsNarrative = cfg.enabled && body?.narrative !== false;
    // 意图解析也可能调用模型（有自然语言时）：即使 narrative=false，只要 AI 启用就先占一次配额，
    // 保证「report 的意图 + 叙述共享一次配额」，不会出现免费的意图调用。
    const needsQuota = cfg.enabled && (wantsNarrative || hasText);
    if (needsQuota) this.quota.consume(userId, cfg.hourlyLimitPerUser);
    let plan: AiAnalyticsPlanResult;
    try {
      plan = await this.plan(body || {}, projectId, user, { consumeQuota: false });
    } catch (e) {
      if (needsQuota) this.quota.refund(userId);
      throw e;
    }
    // 不写叙述时，若意图模型也没成功（回落规则），这次没有成功调用 → 退还
    if (!wantsNarrative && hasText && plan.source === 'rules') this.quota.refund(userId);
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
    const presentation = reportPresentation(intent);
    let markdown = analyticsFactsToMarkdown(facts, presentation);
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
        const narrated = buildNarratedReport(facts, res.data, intent.notes, presentation);
        markdown = narrated.markdown;
        discardedNumbers = narrated.discarded;
        warnings.push(...narrated.warnings);
        if (narrated.accepted) reportSource = 'llm';
        // 整段叙述因对账失败被丢弃 → 按计划 §2.6 退还共享配额（用户拿到的仍是确定性报告）
        if (!narrated.accepted) this.quota.refund(userId);
        usage = res.usage ?? null;
      } catch (e) {
        // 叙述失败也退还共享配额（意图调用无论成败，本次都没有产出模型叙述）
        this.quota.refund(userId);
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
      const row = await this.store.create(
        this.recordPayload({
          projectId,
          user,
          plan,
          facts,
          range,
          periodLabel,
          title,
          warnings,
          factsForStore,
          source: reportSource,
          markdown,
          hasReport: true,
          discardedNumbers,
        }),
      );
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

  /** 当前用户仍可读的数据集 key 集合（历史记录复核权限用） */
  private allowedDatasetKeys(user: JwtUser): ReadonlySet<string> {
    return new Set(filterDatasets(this.can(user)).visible.map((d) => d.key));
  }

  /** 记录落库的公共字段（报告与工作簿共用，避免两份 20+ 字段手拼漂移） */
  private recordPayload(input: {
    projectId: string;
    user: JwtUser;
    plan: AiAnalyticsPlanResult;
    facts: AiAnalyticsFacts;
    range: DayRange;
    periodLabel: string;
    title: string;
    warnings: string[];
    factsForStore: unknown;
    source: 'template' | 'llm';
    markdown: string | null;
    hasReport: boolean;
    unknownNumbers?: string[];
    discardedNumbers?: string[];
    /** `report`（默认）| `chat` */
    answerMode?: string;
    workbook?: { key: string; name: string; size: number };
  }) {
    return {
      projectId: input.projectId,
      createdBy: input.user?.userId ?? null,
      createdByName: input.user?.realName ?? input.user?.username ?? null,
      title: input.title,
      rawText: input.plan.intent.rawText ?? null,
      intentJson: input.plan.intent,
      scopeJson: input.facts.scope,
      datasetKeys: input.plan.intent.datasets,
      factsJson: input.factsForStore,
      warningsJson: input.warnings,
      unknownNumbersJson: input.unknownNumbers ?? [],
      discardedNumbersJson: input.discardedNumbers ?? [],
      scopeMode: input.plan.intent.scope.mode,
      projectCount: input.plan.projects.length,
      periodFrom: input.range.from,
      periodTo: input.range.to,
      periodLabel: input.periodLabel,
      compareMode: input.facts.compareMode,
      narrative: input.source === 'llm',
      source: input.source,
      answerMode: input.answerMode ?? 'report',
      markdown: input.markdown,
      hasReport: input.hasReport,
      ...(input.workbook
        ? {
            workbookKey: input.workbook.key,
            workbookName: input.workbook.name,
            workbookSize: input.workbook.size,
            hasWorkbook: true,
          }
        : {}),
    };
  }

  list(user: JwtUser, query: any) {
    return this.store.list(user, query || {});
  }

  /**
   * 事实包 → 多 sheet xlsx（确定性，不调模型）。
   * 20 万单元格预算在这里统一扣减，截断信息同时写进表头和返回的 warnings。
   */
  private async workbookBuffer(facts: AiAnalyticsFacts) {
    const model = buildAnalyticsWorkbookModel(facts);
    const truncated: string[] = [];
    const buffer = await this.styled.withWorkbook(async (wb) => {
      let cellBudget = 200_000;
      for (const sheet of model) {
        const cols = Math.max(1, sheet.columns.length);
        const maxDataRows = Math.max(0, Math.floor(cellBudget / cols) - 1);
        const rows = sheet.rows.slice(0, maxDataRows);
        if (rows.length < sheet.rows.length) {
          truncated.push(
            `工作表「${sheet.name}」超出工作簿 20 万单元格上限，已截断至 ${rows.length} 行`,
          );
        }
        const note =
          rows.length < sheet.rows.length
            ? [sheet.note, `超出工作簿 20 万单元格上限，已截断至 ${rows.length} 行`].filter(Boolean).join('；')
            : sheet.note;
        cellBudget -= (rows.length + 1) * cols;

        const ws = wb.addWorksheet(sheet.name);
        let headerRow = 1;
        if (note) {
          const noteCell = ws.getCell(1, 1);
          noteCell.value = note;
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
        if (!rows.length) {
          ws.getCell(headerRow + 1, 1).value = '无数据';
        }
        rows.forEach((row, r) => {
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
    return { buffer, model, truncated };
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
    if (body?.reportId) return this.workbookFromRecord(String(body.reportId), user);
    const plan = await this.plan(body || {}, projectId, user, { consumeQuota: false, useIntentLlm: false });
    const now = new Date();
    const range = resolvePresetPeriod(plan.intent.period.preset, now, {
      from: plan.intent.period.from,
      to: plan.intent.period.to,
    });
    if (!range) throw new BadRequestException('期间无法解析：自定义期间需要合法的开始与结束日期');
    const cmpRange = compareRange(range, plan.intent.compare);
    const { facts, scopeLabel, periodLabel } = await this.prepareFacts(plan, range, cmpRange);
    const title = String(body?.title || analyticsTitle(plan.intent.reportKind, scopeLabel, periodLabel)).slice(0, 60);
    const { buffer, model, truncated } = await this.workbookBuffer(facts);

    const fileName = `${title}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    const saved = await this.storage.save(buffer, { sub: projectScopedSub(projectId, 'ai-analytics'), ext: '.xlsx', name: fileName });
    const warnings = [...facts.warnings, ...truncated];
    const factsForStore = {
      ...facts,
      datasets: facts.datasets.map((d) => ({ ...d, rows: d.rows.slice(0, 200) })),
    };
    let id: string;
    try {
      const row = await this.store.create(
        this.recordPayload({
          projectId,
          user,
          plan,
          facts,
          range,
          periodLabel,
          title,
          warnings,
          factsForStore,
          source: 'template',
          markdown: null,
          hasReport: false,
          workbook: { key: saved.key, name: fileName, size: saved.size },
        }),
      );
      id = row.id;
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
      reportId: null,
    };
  }

  /**
   * 从**已存档的报告记录**生成工作簿：不重新解析意图、不重新取数。
   * 这样工作簿里的数字与历史 Markdown / factsJson 严格同源；
   * 数据集权限由 `detail()` 再复核一次（权限被收回后同样 404）。
   */
  private async workbookFromRecord(reportId: string, user: JwtUser) {
    const row = await this.store.detail(reportId, user, this.allowedDatasetKeys(user));
    const facts = row.factsJson as unknown as AiAnalyticsFacts | null;
    if (!facts || !Array.isArray(facts.datasets)) {
      throw new BadRequestException('该记录没有可用的事实快照，请重新生成报告');
    }
    const title = String(row.title || '经营数据表格').slice(0, 60);
    const { buffer, model, truncated } = await this.workbookBuffer(facts);
    const fileName = `${title}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    const saved = await this.storage.save(buffer, { sub: projectScopedSub(row.projectId, 'ai-analytics'), ext: '.xlsx', name: fileName });
    const storedWarnings = Array.isArray(row.warningsJson) ? (row.warningsJson as string[]) : facts.warnings;
    await this.store.attachWorkbook(reportId, user, { key: saved.key, name: fileName, size: saved.size });
    return {
      id: reportId,
      fileName,
      size: saved.size,
      sheets: model.map((s) => s.name),
      warnings: [...storedWarnings, ...truncated],
      reportId,
    };
  }

  /** 下载存档工作簿（只按记录 key 读取；不接受客户端传入路径） */
  async workbookFile(id: string, user: JwtUser) {
    const row = await this.store.detail(id, user, this.allowedDatasetKeys(user));
    if (!row.workbookKey) throw new NotFoundException('该记录没有表格文件');
    const buffer = await this.storage.read(row.workbookKey);
    return { buffer, fileName: row.workbookName || 'analytics.xlsx' };
  }

  detail(id: string, user: JwtUser) {
    return this.store.detail(id, user, this.allowedDatasetKeys(user));
  }

  remove(id: string, user: JwtUser) {
    // 控制器已有 ai:use 守卫；service 再校验一次，避免被其他内部调用绕过
    assertPermission(user, 'ai:use', '删除经营数据记录需要「使用 AI 助手」权限');
    return this.store.remove(id, user);
  }

  /** 用**存档 Markdown** 重新排版导出，不重新取数 */
  async exportRecord(id: string, format: string | undefined, user: JwtUser) {
    const row = await this.store.detail(id, user, this.allowedDatasetKeys(user));
    const markdown = String(row.markdown ?? '').trim();
    if (!markdown) throw new NotFoundException('该记录没有报告正文，无法导出');
    const isPdf = String(format || 'docx').toLowerCase() === 'pdf';
    return isPdf
      ? this.reportService.exportPdf({ markdown, title: row.title })
      : this.reportService.exportDocx({ markdown, title: row.title });
  }
}
