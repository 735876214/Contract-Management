import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertPermission } from '../../../common/utils/assert-permission';
import { SysParamService } from '../../../common/services/sys-param.service';
import { AiQuota } from '../ai-quota';
import { aiModelFor } from '../ai-config';
import { AiSettingService } from '../ai-setting.service';
import { chatJson } from '../llm-client';
import { promptNumberExtras } from '../common/narrative.ts';
import { TASK_STATUS } from '../../../constants/procurementFlow';
import { sampleTotal } from '../common/coverage.ts';
import {
  type CompareItemRow,
  type QuoteFinding,
  type QuoteSummary,
  type QuoteTaskInput,
  centsToYuan,
} from './quote-types.ts';
import { evaluateQuoteAnomalies } from './rules-quote.ts';
import { QUOTE_PARAM_KEY_LIST, parseQuoteConfig, quoteToleranceText, type QuoteConfig } from './quote-config.ts';
import {
  auditQuoteNarrative,
  buildQuoteMessages,
  fallbackQuoteNarrative,
  type QuoteNarrative,
} from './quote-prompt.ts';

export interface QuoteAnomalyQuery {
  /** 只看某个采购任务（面板从任务详情跳进来时用） */
  taskId?: string;
  /** 0/1：强制关闭模型措辞，默认跟随系统参数 */
  narrative?: string;
}

export interface QuoteAnomalyResult {
  /** 系统参数 `ai.quote.enabled` 关掉时为 false（不报错，前端显示「已停用」） */
  enabled: boolean;
  generatedAt: string;
  /** 判定范围的中文描述（面板直接显示） */
  scope: string;
  sample: Record<string, number>;
  tolerances: {
    amount: string;
    dropPct: number;
    spreadPct: number;
    underBudgetPct: number;
    priceDevPct: number;
    taxRateToleranceBp: number;
    minBidders: number;
  };
  summary: QuoteSummary;
  findings: QuoteFinding[];
  notEvaluated: string[];
  narrative: {
    conclusion: string;
    actions: string[];
    /** llm = 模型措辞且对账通过；template = 模板兜底 */
    source: 'llm' | 'template';
    unknownNumbers: string[];
  };
  /** 数据质量与降级说明（面板原样展示，别把降级藏起来） */
  warnings: string[];
}

/**
 * 异常报价与价差识别预警（课题 3-9）。
 *
 * 职责边界与 6-9 的 `AnomalyService` 完全一致：
 * - 本 service 只做「按项目隔离取数」+「把数交给纯函数规则」；
 * - 命中判定与全部算术在 `rules-quote.ts`（纯函数、有真值夹具锁）；
 * - 措辞在 `quote-prompt.ts`（模型只组织语言，对账不过退回模板串）。
 *
 * **只读**：不写任何表、不改任务状态、不发通知（预警不自己动业务数据）。
 *
 * 权限：路由层 `ai:view`；service 层再要 `contract:view`——命中结果里带报价金额与
 * 控制价，和采购任务详情属同一敏感级别（采购模块本身就用 `contract:view`）。
 */
@Injectable()
export class QuoteService {
  private readonly logger = new Logger(QuoteService.name);

  constructor(
    private prisma: PrismaClient,
    private quota: AiQuota,
    private setting: AiSettingService,
    private sysParam: SysParamService,
  ) {}

  private async config(): Promise<QuoteConfig> {
    const values = await Promise.all(QUOTE_PARAM_KEY_LIST.map((k) => this.sysParam.get(k, '')));
    const raw: Record<string, string | undefined> = {};
    QUOTE_PARAM_KEY_LIST.forEach((k, i) => {
      raw[k] = values[i] === '' ? undefined : values[i];
    });
    return parseQuoteConfig(raw);
  }

  async quote(query: QuoteAnomalyQuery, projectId: string, user: any): Promise<QuoteAnomalyResult> {
    const userId = user?.userId || user?.username || 'anonymous';
    assertPermission(
      user,
      'contract:view',
      '报价异常预警会暴露供应商报价与控制价，需要「合同-查看」权限',
    );

    const cfg = await this.config();
    const empty: QuoteAnomalyResult = {
      enabled: cfg.enabled,
      generatedAt: new Date().toISOString(),
      scope: query?.taskId ? `采购任务 ${query.taskId}` : '本项目全部采购任务',
      sample: {},
      tolerances: {
        amount: centsToYuan(cfg.tolerances.amount),
        dropPct: cfg.tolerances.dropPct,
        spreadPct: cfg.tolerances.spreadPct,
        underBudgetPct: cfg.tolerances.underBudgetPct,
        priceDevPct: cfg.tolerances.priceDevPct,
        taxRateToleranceBp: cfg.tolerances.taxRateToleranceBp,
        minBidders: cfg.tolerances.minBidders,
      },
      summary: { total: 0, high: 0, medium: 0, byCode: {} },
      findings: [],
      notEvaluated: [],
      narrative: { conclusion: '', actions: [], source: 'template', unknownNumbers: [] },
      warnings: [...cfg.problems],
    };
    if (!cfg.enabled) {
      empty.warnings.push('报价异常预警已在系统参数里停用（ai.quote.enabled=0），未执行任何判定');
      empty.notEvaluated.push('预警未启用（ai.quote.enabled=0）：本次未执行任何规则，不能视作「无异常」');
      empty.narrative.conclusion = '报价异常预警已停用。如需恢复，请让管理员把系统参数 ai.quote.enabled 设为 1。';
      return empty;
    }

    const { tasks, sample, scope, warnings } = await this.collect(query, projectId);
    const evaluation = evaluateQuoteAnomalies({ tasks, tolerances: cfg.tolerances });

    const result: QuoteAnomalyResult = {
      ...empty,
      scope,
      sample,
      summary: evaluation.summary,
      findings: evaluation.findings,
      notEvaluated: evaluation.notEvaluated,
      warnings: [...empty.warnings, ...warnings],
    };

    // 「没有数据」≠「没有异常」
    if (sampleTotal(result.sample) === 0) result.notEvaluated.push('本次扫描范围内没有任何可用数据，未执行判定（不能视作「无异常」）');

    // 0 命中不打模型：既费额度，又容易写成「已核查确认无风险」这种越权结论
    const wantNarrative = cfg.narrative && String(query?.narrative ?? '1') !== '0';
    if (!wantNarrative || !evaluation.findings.length) {
      result.narrative = { ...fallbackQuoteNarrative(evaluation), source: 'template', unknownNumbers: [] };
      if (!wantNarrative) result.warnings.push('模型措辞已关闭（ai.quote.narrative=0），结论为模板串');
      return result;
    }

    const ai = await this.setting.resolve();
    if (!ai.enabled) {
      result.narrative = { ...fallbackQuoteNarrative(evaluation), source: 'template', unknownNumbers: [] };
      result.warnings.push('AI 未配置（接口地址 / API Key / 模型名），结论为模板串：请到「系统管理 → AI 信息登记」填写');
      return result;
    }

    this.quota.consume(userId, ai.hourlyLimitPerUser);
    try {
      const toleranceText = quoteToleranceText(cfg.tolerances);
      const promptExtras = promptNumberExtras(
        sample,
        [
          evaluation.summary.total,
          evaluation.summary.high,
          evaluation.summary.medium,
          evaluation.notEvaluated.length,
          ...Object.values(evaluation.summary.byCode ?? {}),
        ],
        // 「未判定」文案里的数字也是系统给的，复述出来不算编造
        [toleranceText, ...evaluation.notEvaluated],
      );
      const messages = buildQuoteMessages({
        scope,
        sample,
        toleranceText,
        evaluation,
      });
      const res = await chatJson(
        globalThis.fetch as any,
        {
          baseUrl: ai.baseUrl,
          apiKey: ai.apiKey,
          // 与结算/履约预警同属「异常预警」用途
          model: aiModelFor(ai, 'anomaly'),
          timeoutMs: Math.max(ai.timeoutMs, 60000),
          temperature: 0.2,
          maxTokens: ai.maxTokens,
        },
        messages,
      );

      const narrative = this.readNarrative(res.data);
      if (!narrative) {
        this.quota.refund(userId);
        result.narrative = { ...fallbackQuoteNarrative(evaluation), source: 'template', unknownNumbers: [] };
        result.warnings.push('模型返回的结构不可用（缺 conclusion/actions），结论已回落模板串');
        return result;
      }

      const unknown = auditQuoteNarrative(narrative, evaluation, promptExtras);
      if (unknown.length) {
        // 对账失败＝模型编了数字，一律丢弃（宁可用模板串，也不给人一份带假数字的结论）
        // 用户没拿到可用结论 ⇒ 与「模型返回不可用」同样退额度
        this.quota.refund(userId);
        result.narrative = { ...fallbackQuoteNarrative(evaluation), source: 'template', unknownNumbers: unknown };
        result.warnings.push(
          `模型结论里出现了系统数据之外的数字（${unknown.slice(0, 5).join('、')}），已丢弃并回落模板串`,
        );
        return result;
      }

      result.narrative = { ...narrative, source: 'llm', unknownNumbers: [] };
      return result;
    } catch (e: any) {
      this.quota.refund(userId);
      const msg = e?.message || String(e);
      this.logger.warn(`报价异常预警措辞生成失败：${msg}`);
      result.narrative = { ...fallbackQuoteNarrative(evaluation), source: 'template', unknownNumbers: [] };
      result.warnings.push(`模型调用失败（${msg}），结论已回落模板串；判定结果本身不受影响`);
      return result;
    }
  }

  /** 只认 `{ conclusion, actions[] }`，别的一律当不可用 */
  private readNarrative(data: unknown): QuoteNarrative | null {
    const obj = data as any;
    if (!obj || typeof obj !== 'object') return null;
    const conclusion = typeof obj.conclusion === 'string' ? obj.conclusion.trim() : '';
    const actions = Array.isArray(obj.actions)
      ? obj.actions.filter((a: unknown) => typeof a === 'string' && String(a).trim()).map((a: string) => a.trim())
      : [];
    if (!conclusion || !actions.length) return null;
    return { conclusion, actions: actions.slice(0, 8) };
  }

  /**
   * 按项目取数（**每个 where 都显式带 projectId**，铁律 3）。
   *
   * 四张表一次取全在内存按任务聚合：单个项目的采购任务是几十个量级，
   * 全量取回的列都窄（金额/单价/编号），比按任务循环查库快得多也好读。
   */
  private async collect(
    query: QuoteAnomalyQuery,
    projectId: string,
  ): Promise<{ tasks: QuoteTaskInput[]; sample: Record<string, number>; scope: string; warnings: string[] }> {
    const warnings: string[] = [];
    const taskWhere: any = { projectId };
    if (query?.taskId) taskWhere.id = query.taskId;

    const tasks = await this.prisma.procurementTask.findMany({
      where: taskWhere,
      select: { id: true, taskNo: true, content: true, status: true },
      orderBy: { createdAt: 'desc' },
    });
    const taskIds = tasks.map((t) => t.id);
    if (!taskIds.length) {
      return { tasks: [], sample: {}, scope: '本项目暂无采购任务', warnings };
    }

    const [bidders, totalItems, priceCompares] = await Promise.all([
      this.prisma.procurementBidder.findMany({
        where: { projectId, taskId: { in: taskIds } },
        select: {
          id: true,
          taskId: true,
          bidderName: true,
          seq: true,
          passedFirst: true,
          firstPreTaxTotal: true,
          firstTax: true,
          secondPreTaxTotal: true,
          secondTax: true,
          finalPreTaxTotal: true,
          status: true,
        },
      }),
      this.prisma.procurementTotalItem.findMany({
        where: { projectId, taskId: { in: taskIds } },
        select: {
          id: true,
          taskId: true,
          materialBaseId: true,
          materialName: true,
          spec: true,
          unit: true,
          qty: true,
          planPrice: true,
          marketPrice: true,
          infoPrice: true,
          stdCost: true,
          incomePrice: true,
          sortOrder: true,
        },
        orderBy: [{ taskId: 'asc' }, { sortOrder: 'asc' }],
      }),
      this.prisma.procurementPriceCompare.findMany({
        where: { projectId, taskId: { in: taskIds } },
        select: { taskId: true, items: true, publishedAt: true },
      }),
    ]);

    const compareByTask = new Map<string, CompareItemRow[]>();
    // 只有**已发布**的价格对比表才算数：`publishedAt` 是「对比表阶段发布后回填」，
    // 编辑中的草稿成交价还在改，拿它判 B4 单价异常会报出一串「成交价与市场价差太多」的假异常
    let draftCompares = 0;
    for (const pc of priceCompares) {
      if (!pc.publishedAt) {
        draftCompares += 1;
        continue;
      }
      const parsed = this.parseCompareItems(pc.items);
      if (parsed.length) compareByTask.set(pc.taskId, parsed);
      else if (pc.items) warnings.push(`采购价格对比表（任务 ${pc.taskId}）的明细 JSON 解析失败，相关单行单价规则未参与判定`);
    }
    if (draftCompares) {
      warnings.push(`${draftCompares} 份采购价格对比表尚未发布，其成交价未参与单行单价判定（草稿数据不算异常）`);
    }

    const byTask = <T extends { taskId?: string | null }>(rows: T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const r of rows) {
        const key = String(r.taskId ?? '');
        if (!key) continue;
        const arr = map.get(key);
        if (arr) arr.push(r);
        else map.set(key, [r]);
      }
      return map;
    };

    const bidderMap = byTask(bidders);
    const itemMap = byTask(totalItems);

    const inputs: QuoteTaskInput[] = tasks.map((t) => ({
      task: {
        id: t.id,
        taskNo: t.taskNo ?? null,
        name: t.content ?? null,
        status: t.status ?? null,
        stage: null,
      },
      bidders: (bidderMap.get(t.id) ?? []) as any,
      items: (itemMap.get(t.id) ?? []) as any,
      compareItems: compareByTask.get(t.id) ?? [],
    }));

    /**
     * **空壳任务不参与判定**（M8）。未发起的任务、以及既没有响应单位也没有总采购清单的任务，
     * 每条都会产出 7 条「未判定」，几十个任务就是几百行噪音——真正的疑点被淹掉。
     * 这里直接剔除，并把剔除数量写进 warnings（不静默跳过）。
     */
    const judged = inputs.filter(
      (t) =>
        String(t.task?.status ?? '') !== TASK_STATUS.NOT_STARTED &&
        (t.bidders.length > 0 || (t.items?.length ?? 0) > 0 || (t.compareItems?.length ?? 0) > 0),
    );
    const shellCount = inputs.length - judged.length;
    if (shellCount > 0) {
      warnings.push(
        '已跳过 ' + shellCount + ' 个尚未产生数据（未发起 / 无响应单位 / 无清单）的采购任务，其疑点未参与判定',
      );
    }
    if (!judged.length) {
      return { tasks: [], sample: {}, scope: '本项目的采购任务都还没有可判定的数据', warnings };
    }
    const usable = judged;

    const sample: Record<string, number> = {
      采购任务: usable.length,
      响应单位: usable.reduce((n, t) => n + t.bidders.length, 0),
      总采购清单行: usable.reduce((n, t) => n + (t.items?.length ?? 0), 0),
      价格对比表明细: usable.reduce((n, t) => n + (t.compareItems?.length ?? 0), 0),
    };
    const taskNo = tasks[0]?.taskNo;
    const scope = query?.taskId
      ? `采购任务 ${taskNo ?? query.taskId}`
      : `本项目可判定的采购任务（${usable.length} 个）`;

    return { tasks: usable, sample, scope, warnings };
  }

  /** `ProcurementPriceCompare.items` 是 JSON 字符串；坏了不能让整个接口 500，交给 warnings */
  private parseCompareItems(raw: string | null | undefined): CompareItemRow[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.items) ? (parsed as any).items : [];
      return rows.filter((r: any) => r && typeof r === 'object') as CompareItemRow[];
    } catch {
      return [];
    }
  }
}
