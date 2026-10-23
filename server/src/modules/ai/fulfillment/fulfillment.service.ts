import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertPermission } from '../../../common/utils/assert-permission';
import { SysParamService } from '../../../common/services/sys-param.service';
import { AiQuota } from '../ai-quota';
import { aiModelFor } from '../ai-config';
import { AiSettingService } from '../ai-setting.service';
import { chatJson } from '../llm-client';
import { centsToYuan } from '../common/money.ts';
import {
  type FulfillmentContractRow,
  type FulfillmentFinding,
  type FulfillmentInput,
  type FulfillmentSummary,
  FULFILLMENT_CODE_LABELS,
} from './fulfillment-types.ts';
import { evaluateFulfillmentAnomalies } from './rules-fulfillment.ts';
import type { FulfillmentEvaluation } from './rules-fulfillment.ts';
import {
  FULFILLMENT_PARAM_KEY_LIST,
  fulfillmentToleranceText,
  parseFulfillmentConfig,
  type FulfillmentConfig,
} from './fulfillment-config.ts';
import {
  auditFulfillmentNarrative,
  buildFulfillmentMessages,
  fallbackFulfillmentNarrative,
  type FulfillmentNarrative,
} from './fulfillment-prompt.ts';

export interface FulfillmentAnomalyQuery {
  /** 只看某个合同（合同详情页跳进来时用） */
  contractId?: string;
  /** 0/1：强制关闭模型措辞，默认跟随系统参数 */
  narrative?: string;
}

export interface FulfillmentAnomalyResult {
  /** 系统参数 `ai.fulfillment.enabled` 关掉时为 false（不报错，前端显示「已停用」） */
  enabled: boolean;
  generatedAt: string;
  /** 判定范围的中文描述（面板直接显示） */
  scope: string;
  sample: Record<string, number>;
  tolerances: {
    amount: string;
    graceDays: number;
    lateFinishDays: number;
    progressGapPct: number;
  };
  summary: FulfillmentSummary;
  findings: FulfillmentFinding[];
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
 * 合同履行偏差预警（课题 4-9）。
 *
 * 职责边界与 6-9 / 3-9 完全一致：
 * - 本 service 只做「按项目隔离取数」+「把数交给纯函数规则」；
 * - 判定与全部算术在 `rules-fulfillment.ts`（纯函数、有真值夹具锁）；
 * - 措辞在 `fulfillment-prompt.ts`（模型只组织语言，对账不过退回模板串）。
 *
 * **只读**：不写任何表、不改节点状态、不发通知。
 *
 * 权限：路由层 `ai:view`；service 层再要 `contract:view`——命中结果带合同金额与付款进度，
 * 与合同台账属同一敏感级别。
 */
@Injectable()
export class FulfillmentService {
  private readonly logger = new Logger(FulfillmentService.name);

  constructor(
    private prisma: PrismaClient,
    private quota: AiQuota,
    private setting: AiSettingService,
    private sysParam: SysParamService,
  ) {}

  private async config(): Promise<FulfillmentConfig> {
    const values = await Promise.all(FULFILLMENT_PARAM_KEY_LIST.map((k) => this.sysParam.get(k, '')));
    const raw: Record<string, string | undefined> = {};
    FULFILLMENT_PARAM_KEY_LIST.forEach((k, i) => {
      raw[k] = values[i] === '' ? undefined : values[i];
    });
    return parseFulfillmentConfig(raw);
  }

  async fulfillment(
    query: FulfillmentAnomalyQuery,
    projectId: string,
    user: any,
  ): Promise<FulfillmentAnomalyResult> {
    const userId = user?.userId || user?.username || 'anonymous';
    assertPermission(user, 'contract:view', '履约偏差预警会暴露合同金额与付款进度，需要「合同-查看」权限');

    const cfg = await this.config();
    const result: FulfillmentAnomalyResult = {
      enabled: cfg.enabled,
      generatedAt: new Date().toISOString(),
      scope: query?.contractId ? `合同 ${query.contractId}` : '本项目全部在履行合同',
      sample: {},
      tolerances: {
        amount: centsToYuan(cfg.tolerances.amount),
        graceDays: cfg.tolerances.graceDays,
        lateFinishDays: cfg.tolerances.lateFinishDays,
        progressGapPct: cfg.tolerances.progressGapPct,
      },
      summary: { total: 0, high: 0, medium: 0, byCode: {} },
      findings: [],
      notEvaluated: [],
      narrative: { conclusion: '', actions: [], source: 'template', unknownNumbers: [] },
      warnings: [...cfg.problems],
    };

    if (!cfg.enabled) {
      result.warnings.push('履约偏差预警已在系统参数里停用（ai.fulfillment.enabled=0），未执行任何判定');
      result.narrative.conclusion =
        '履约偏差预警已停用。如需恢复，请让管理员把系统参数 ai.fulfillment.enabled 设为 1。';
      return result;
    }

    const collected = await this.collect(query, projectId);
    result.scope = collected.scope;
    result.sample = collected.sample;
    result.warnings.push(...collected.warnings);

    const input: FulfillmentInput = { ...collected.input, tolerances: cfg.tolerances };
    const evaluation: FulfillmentEvaluation = evaluateFulfillmentAnomalies(input);
    result.summary = evaluation.summary;
    result.findings = evaluation.findings;
    result.notEvaluated = evaluation.notEvaluated;

    const wantNarrative = cfg.narrative && String(query?.narrative ?? '1') !== '0';
    if (!wantNarrative || !evaluation.findings.length) {
      result.narrative = { ...fallbackFulfillmentNarrative(evaluation), source: 'template', unknownNumbers: [] };
      if (!wantNarrative) result.warnings.push('模型措辞已关闭（ai.fulfillment.narrative=0），结论为模板串');
      return result;
    }

    const ai = await this.setting.resolve();
    if (!ai.enabled) {
      result.narrative = { ...fallbackFulfillmentNarrative(evaluation), source: 'template', unknownNumbers: [] };
      result.warnings.push(
        'AI 未配置（接口地址 / API Key / 模型名），结论为模板串：请到「系统管理 → AI 信息登记」填写',
      );
      return result;
    }

    this.quota.consume(userId, ai.hourlyLimitPerUser);
    try {
      const messages = buildFulfillmentMessages({
        scope: collected.scope,
        sample: collected.sample,
        toleranceText: fulfillmentToleranceText(cfg.tolerances),
        evaluation,
      });
      const res = await chatJson(
        globalThis.fetch as any,
        {
          baseUrl: ai.baseUrl,
          apiKey: ai.apiKey,
          // 与结算/报价预警同属「异常预警」用途
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
        result.narrative = { ...fallbackFulfillmentNarrative(evaluation), source: 'template', unknownNumbers: [] };
        result.warnings.push('模型返回的结构不可用（缺 conclusion/actions），结论已回落模板串');
        return result;
      }

      const unknown = auditFulfillmentNarrative(narrative, evaluation);
      if (unknown.length) {
        // 对账失败＝模型编了数字，一律丢弃（宁可用模板串，也不给人一份带假数字的结论）
        result.narrative = { ...fallbackFulfillmentNarrative(evaluation), source: 'template', unknownNumbers: unknown };
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
      this.logger.warn(`履约偏差预警措辞生成失败：${msg}`);
      result.narrative = { ...fallbackFulfillmentNarrative(evaluation), source: 'template', unknownNumbers: [] };
      result.warnings.push(`模型调用失败（${msg}），结论已回落模板串；判定结果本身不受影响`);
      return result;
    }
  }

  /** 只认 `{ conclusion, actions[] }`，别的一律当不可用 */
  private readNarrative(data: unknown): FulfillmentNarrative | null {
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
   * 四张表一次取全在内存按合同聚合：单项目的在履行合同是几十个量级，
   * 取回的列都窄（日期/状态/金额），比按合同循环查库快得多也好读。
   */
  private async collect(
    query: FulfillmentAnomalyQuery,
    projectId: string,
  ): Promise<{
    input: Omit<FulfillmentInput, 'tolerances'>;
    sample: Record<string, number>;
    scope: string;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    // 只看「在履行」的合同：草稿没签章谈不上履约偏差；已终止的合同本文档口径里不存在
    const contractWhere: any = { projectId };
    if (query?.contractId) contractWhere.id = query.contractId;
    else contractWhere.OR = [{ status: null }, { status: { not: 'DRAFT' } }];

    const contracts = await this.prisma.contract.findMany({
      where: contractWhere,
      select: {
        id: true,
        code: true,
        name: true,
        amount: true,
        changeAmount: true,
        parentContractId: true,
        signDate: true,
        signedDate: true,
        status: true,
        execStatus: true,
      },
      orderBy: { code: 'asc' },
    });
    const contractIds = contracts.map((c) => c.id);
    if (!contractIds.length) {
      return {
        input: { contracts: [], milestones: [], payments: [], finalSettlements: [] },
        sample: {},
        scope: '本项目暂无可判定的合同',
        warnings,
      };
    }

    const [milestones, payments, finalSettlements] = await Promise.all([
      this.prisma.contractFulfillment.findMany({
        where: { projectId, contractId: { in: contractIds } },
        select: {
          id: true,
          contractId: true,
          name: true,
          planDate: true,
          actualDate: true,
          statusCode: true,
          owner: true,
        },
        orderBy: [{ planDate: 'asc' }],
      }),
      this.prisma.paymentRecord.findMany({
        where: { projectId, contractId: { in: contractIds } },
        select: { id: true, contractId: true, amount: true, payDate: true, statusCode: true },
      }),
      this.prisma.finalSettlement.findMany({
        where: { projectId, contractId: { in: contractIds } },
        select: { id: true, contractId: true, statusCode: true, settledAt: true },
      }),
    ]);

    const contractRows: FulfillmentContractRow[] = contracts.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      amount: c.amount,
      changeAmount: c.changeAmount,
      parentContractId: c.parentContractId,
      signDate: c.signDate,
      signedDate: c.signedDate,
      status: c.status,
      execStatus: c.execStatus,
    }));

    const sample: Record<string, number> = {
      合同: contractRows.length,
      履约节点: milestones.length,
      付款: payments.length,
      终期结算: finalSettlements.length,
    };

    const scope = query?.contractId
      ? `合同 ${contracts[0]?.code ?? query.contractId}`
      : `本项目全部在履行合同（${contractRows.length} 份）`;

    if (!milestones.length) {
      warnings.push('本项目在履行合同没有任何履约节点，C1–C7 无法判定（C8 会逐份报出缺节点的合同）');
    }

    return {
      input: {
        contracts: contractRows,
        milestones: milestones.map((m) => ({
          id: m.id,
          contractId: m.contractId,
          name: m.name,
          planDate: m.planDate,
          actualDate: m.actualDate,
          statusCode: m.statusCode,
          owner: m.owner,
        })),
        payments: payments.map((p) => ({
          id: p.id,
          contractId: p.contractId,
          amount: p.amount,
          payDate: p.payDate,
          statusCode: p.statusCode,
        })),
        finalSettlements: finalSettlements.map((f) => ({
          id: f.id,
          contractId: f.contractId,
          statusCode: f.statusCode,
          settledAt: f.settledAt,
        })),
        // 基准日由 service 注入，规则层不读系统时钟（单测才能固定）
        now: new Date(),
      },
      sample,
      scope,
      warnings,
    };
  }
}

/** 供控制器/面板复用的规则码中文名（避免前端再抄一份） */
export const FULFILLMENT_CODE_TEXT = FULFILLMENT_CODE_LABELS;
