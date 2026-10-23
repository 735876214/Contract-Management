import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertPermission } from '../../../common/utils/assert-permission';
import { SysParamService } from '../../../common/services/sys-param.service';
import { AiQuota } from '../ai-quota';
import { aiModelFor } from '../ai-config';
import { AiSettingService } from '../ai-setting.service';
import { chatJson } from '../llm-client';
import {
  type Finding,
  type PaymentAnomalyInput,
  type AnomalySummary,
  centsToYuan,
} from './anomaly-types.ts';
import { evaluatePaymentAnomalies } from './rules-payment.ts';
import { ANOMALY_PARAM_KEY_LIST, parseAnomalyConfig, type AnomalyConfig } from './anomaly-config.ts';
import { promptNumberExtras } from '../common/narrative.ts';
import { sampleTotal } from '../common/coverage.ts';
import {
  auditNarrative,
  buildAnomalyMessages,
  fallbackNarrative,
  type AnomalyNarrative,
} from './anomaly-prompt.ts';
import {
  ANOMALY_ORDER,
  ANOMALY_SELECT,
  buildAnomalyWhere,
  buildPaymentAnomalyInput,
} from './anomaly-dataset.ts';

export interface PaymentAnomalyQuery {
  from?: string;
  to?: string;
  contractId?: string;
  /** 0/1：强制关闭模型措辞（面板「只看规则结果」用），默认跟随系统参数 */
  narrative?: string;
}

export interface PaymentAnomalyResult {
  /** 系统参数 `ai.anomaly.enabled` 关掉时为 false（不报错，前端显示「已停用」） */
  enabled: boolean;
  generatedAt: string;
  period: { from: string | null; to: string | null };
  /** 参与判定的样本量：面板据此说明「基于多少单据算的」，也是 0 命中时的可信度依据 */
  sample: Record<string, number>;
  tolerances: { amount: string; qtyPct: number; jaccard: number };
  summary: AnomalySummary;
  findings: Finding[];
  notEvaluated: string[];
  narrative: {
    conclusion: string;
    actions: string[];
    /** llm = 模型措辞且对账通过；template = 模板兜底（模型未配置/失败/对账失败/0 命中） */
    source: 'llm' | 'template';
    unknownNumbers: string[];
  };
  warnings: string[];
}

/**
 * 结算 / 付款异常预警（课题 6-9）。
 *
 * 职责边界（**这是本模块最重要的约定**）：
 * - 本 service 只做两件事：**按项目隔离取数** + **把数交给纯函数规则**；
 * - 命中判定与全部算术都在 `rules-payment.ts`（纯函数、有真值夹具锁）；
 * - 措辞在 `anomaly-prompt.ts`（模型只组织语言，对账不过就退回模板串）。
 *
 * **只读**：不写任何表、不发通知（产品决策：预警先只读，避免「预警自己改数据」）。
 * 需要提醒时由前端/后续工单决定，而不是这里偷偷落库。
 *
 * 权限：路由层要 `ai:view`（能看 AI 入口），service 层再要 `contract:view`
 * ——命中结果里带合同/结算/付款金额，和汇报材料是同一类敏感数据
 * （与 `report.service.ts` 的 assertPermission 同口径）。
 */
@Injectable()
export class AnomalyService {
  private readonly logger = new Logger(AnomalyService.name);

  constructor(
    private prisma: PrismaClient,
    private quota: AiQuota,
    private setting: AiSettingService,
    private sysParam: SysParamService,
  ) {}

  /** 读系统参数 → 解析成配置（读库失败时 SysParamService 自带默认值回落） */
  private async config(): Promise<AnomalyConfig> {
    const values = await Promise.all(ANOMALY_PARAM_KEY_LIST.map((k) => this.sysParam.get(k, '')));
    const raw: Record<string, string | undefined> = {};
    ANOMALY_PARAM_KEY_LIST.forEach((k, i) => {
      raw[k] = values[i] === '' ? undefined : values[i];
    });
    return parseAnomalyConfig(raw);
  }

  async payment(query: PaymentAnomalyQuery, projectId: string, user: any): Promise<PaymentAnomalyResult> {
    const userId = user?.userId || user?.username || 'anonymous';
    assertPermission(
      user,
      'contract:view',
      '结算/付款异常预警会暴露合同、结算与付款金额，需要「合同-查看」权限',
    );

    const cfg = await this.config();
    const empty: PaymentAnomalyResult = {
      enabled: cfg.enabled,
      generatedAt: new Date().toISOString(),
      period: { from: query?.from || null, to: query?.to || null },
      sample: {},
      tolerances: {
        amount: centsToYuan(cfg.tolerances.amount),
        qtyPct: cfg.tolerances.qtyPct,
        jaccard: cfg.tolerances.jaccard,
      },
      summary: { total: 0, high: 0, medium: 0, byCode: {} },
      findings: [],
      notEvaluated: [],
      narrative: { conclusion: '', actions: [], source: 'template', unknownNumbers: [] },
      warnings: [...cfg.problems],
    };
    if (!cfg.enabled) {
      empty.warnings.push('异常预警已在系统参数里停用（ai.anomaly.enabled=0），未执行任何判定');
      empty.notEvaluated.push('预警未启用（ai.anomaly.enabled=0）：本次未执行任何规则，不能视作「无异常」');
      empty.narrative.conclusion = '异常预警已停用。如需恢复，请让管理员把系统参数 ai.anomaly.enabled 设为 1。';
      return empty;
    }

    const { input, sample } = await this.collect(query, projectId);
    const evaluation = evaluatePaymentAnomalies({ ...input, tolerances: cfg.tolerances });

    const result: PaymentAnomalyResult = {
      ...empty,
      sample,
      summary: evaluation.summary,
      findings: evaluation.findings,
      notEvaluated: evaluation.notEvaluated,
    };

    // 「没有数据」≠「没有异常」：样本全 0 时必须说出来，否则面板会把「一条没查」渲染成绿色通过
    if (sampleTotal(result.sample) === 0) result.notEvaluated.push('本次扫描范围内没有任何可用数据，未执行判定（不能视作「无异常」）');

    // 0 命中时不打模型：让模型写「没有问题」既费额度，又容易写成「已核查确认无风险」这种越权结论
    const wantNarrative = cfg.narrative && String(query?.narrative ?? '1') !== '0';
    if (!wantNarrative || !evaluation.findings.length) {
      result.narrative = { ...fallbackNarrative(evaluation), source: 'template', unknownNumbers: [] };
      if (!wantNarrative) result.warnings.push('模型措辞已关闭（ai.anomaly.narrative=0），结论为模板串');
      return result;
    }

    const ai = await this.setting.resolve();
    if (!ai.enabled) {
      result.narrative = { ...fallbackNarrative(evaluation), source: 'template', unknownNumbers: [] };
      result.warnings.push('AI 未配置（接口地址 / API Key / 模型名），结论为模板串：请到「系统管理 → AI 信息登记」填写');
      return result;
    }

    this.quota.consume(userId, ai.hourlyLimitPerUser);
    try {
      const toleranceText = `金额容差 ${centsToYuan(cfg.tolerances.amount)} 元；数量容差 +${cfg.tolerances.qtyPct}%；明细重合度 ${cfg.tolerances.jaccard}`;
      const promptExtras = promptNumberExtras(
        sample,
        [
          evaluation.summary.total,
          evaluation.summary.high,
          evaluation.summary.medium,
          evaluation.notEvaluated.length,
          ...Object.values(evaluation.summary.byCode ?? {}),
        ],
        // 「未判定」文案里也带数字（如「3 条规则未参与判定」），提示词给过的数不能算编造
        [toleranceText, result.period ? `${result.period.from} 至 ${result.period.to}` : null, ...evaluation.notEvaluated],
      );
      const messages = buildAnomalyMessages({
        period: result.period,
        sample,
        toleranceText,
        evaluation,
      });
      const res = await chatJson(globalThis.fetch as any, {
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey,
        // 三类预警（结算/报价/履约）共用「异常预警」用途
        model: aiModelFor(ai, 'anomaly'),
        timeoutMs: Math.max(ai.timeoutMs, 60000),
        temperature: 0.2,
        maxTokens: ai.maxTokens,
      }, messages);

      const narrative = this.readNarrative(res.data);
      if (!narrative) {
        this.quota.refund(userId);
        result.narrative = { ...fallbackNarrative(evaluation), source: 'template', unknownNumbers: [] };
        result.warnings.push('模型返回的结构不可用（缺 conclusion/actions），结论已回落模板串');
        return result;
      }

      // 提示词自己给过模型的数字（样本计数、命中总数、阈值）复述出来是「抄」不是「编」
      const unknown = auditNarrative(narrative, evaluation, promptExtras);
      if (unknown.length) {
        // 对账失败＝模型编了数字，一律丢弃（宁可用干巴巴的模板串，也不给人一份带假数字的结论）
        // 用户没拿到可用结论，与「模型返回不可用」同样退额度（否则编数字还倒扣用户配额）
        this.quota.refund(userId);
        result.narrative = { ...fallbackNarrative(evaluation), source: 'template', unknownNumbers: unknown };
        result.warnings.push(
          `模型结论里出现了系统数据之外的数字（${unknown.slice(0, 5).join('、')}），已丢弃并回落模板串`,
        );
        return result;
      }

      result.narrative = { ...narrative, source: 'llm', unknownNumbers: [] };
      return result;
    } catch (e: any) {
      // 失败不占额度（与 report / 登记同一口径）
      this.quota.refund(userId);
      const msg = e?.message || String(e);
      this.logger.warn(`异常预警措辞生成失败：${msg}`);
      result.narrative = { ...fallbackNarrative(evaluation), source: 'template', unknownNumbers: [] };
      result.warnings.push(`模型调用失败（${msg}），结论已回落模板串；判定结果本身不受影响`);
      return result;
    }
  }

  /** 只认 `{ conclusion: string, actions: string[] }`，别的一律当不可用 */
  private readNarrative(data: unknown): AnomalyNarrative | null {
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
   * 一次取全后在内存聚合，不按合同循环查库：项目级命中量是几十条量级，
   * 全量取回的列都是窄列（金额/日期/编号），比 N+1 快得多也好读。
   */
  private async collect(
    query: PaymentAnomalyQuery,
    projectId: string,
  ): Promise<{ input: PaymentAnomalyInput; sample: Record<string, number> }> {
    const from = query?.from ? startOfDay(new Date(query.from)) : null;
    const to = query?.to ? endOfDay(new Date(query.to)) : null;
    if (from && Number.isNaN(from.getTime())) throw new BadRequestException(`起始日期不合法：${query.from}`);
    if (to && Number.isNaN(to.getTime())) throw new BadRequestException(`结束日期不合法：${query.to}`);
    if (from && to && from > to) throw new BadRequestException('起始日期不能晚于结束日期');

    // 下钻到补充协议时，取数必须带上整条链：结算/付款/清单量分散在母合同与各补充协议上，
    // 只取当前合同会让「累计口径」的规则（R1-a/R1-b/R2/R6）把分母算窄，甚至
    // 反过来断言「项目内没有清单量可供对比」（2026-10-23 审计）
    const chainIds = await this.resolveChainIds(projectId, query?.contractId);
    const range = { from, to, contractId: query?.contractId || null, contractIds: chainIds };
    const w = buildAnomalyWhere(range, projectId);

    const [
      contracts,
      settlements,
      cumulativeSettlements,
      payments,
      invoices,
      procedures,
      receipts,
      finalSettlementItems,
      materialRows,
    ] = await Promise.all([
        this.prisma.contract.findMany({ where: w.contractWhere, select: ANOMALY_SELECT.contract }),
        this.prisma.settlement.findMany({
          where: w.settlementWhere,
          select: ANOMALY_SELECT.settlement,
          orderBy: ANOMALY_ORDER.settlement as any,
        }),
        this.prisma.settlement.findMany({
          where: w.settlementCumulativeWhere,
          select: ANOMALY_SELECT.settlement,
          orderBy: ANOMALY_ORDER.settlement as any,
        }),
        this.prisma.paymentRecord.findMany({
          where: w.paymentWhere,
          select: ANOMALY_SELECT.payment,
          orderBy: ANOMALY_ORDER.payment as any,
        }),
        this.prisma.invoice.findMany({ where: w.invoiceWhere, select: ANOMALY_SELECT.invoice }),
        this.prisma.paymentProcedure.findMany({
          where: w.procedureWhere,
          select: ANOMALY_SELECT.procedure,
          orderBy: ANOMALY_ORDER.procedure as any,
        }),
        this.prisma.receiptOrder.findMany({ where: w.receiptWhere, select: ANOMALY_SELECT.receipt }),
        this.prisma.finalSettlementItem.findMany({
          where: w.finalSettlementItemWhere,
          select: ANOMALY_SELECT.finalSettlementItem,
        }),
        this.prisma.contractMaterial.findMany({
          where: w.contractMaterialWhere,
          select: ANOMALY_SELECT.contractMaterial,
        }),
      ]);

    // 形状搬运 + 清单量按链根聚合，全部在纯函数里（离线评测脚本复用同一份）
    return buildPaymentAnomalyInput(
      {
        contracts: contracts as any[],
        settlements: settlements as any[],
        cumulativeSettlements: cumulativeSettlements as any[],
        payments: payments as any[],
        invoices: invoices as any[],
        procedures: procedures as any[],
        receipts: receipts as any[],
        finalSettlementItems: finalSettlementItems as any[],
        materialRows: materialRows as any[],
      },
      range,
    );
  }

  /**
   * 下钻合同 → 整条补充协议链的合同 id 集合（母合同 + 全部层级的下游补充协议）。
   *
   * 不返回 null 时上游按链取数；未下钻（未传 contractId）时整项目取数，
   * 口径本来就完整，返回 null 让 `buildAnomalyWhere` 走原路径。
   */
  private async resolveChainIds(projectId: string, contractId?: string): Promise<string[] | null> {
    if (!contractId) return null;
    const seed = await this.prisma.contract.findFirst({
      where: { id: contractId, projectId },
      select: { id: true, parentContractId: true },
    });
    // 不属于本项目 / 不存在：明确 404，避免「查不到数据」被当成「没有异常」
    if (!seed) throw new NotFoundException('合同不存在或不属于当前项目');

    const ids = new Set<string>([seed.id]);
    // 1) 向上找到链根（防御异常数据里的环：最多 32 层）
    let cursor: string | null = seed.parentContractId ?? null;
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      const parent: { id: string; parentContractId: string | null } | null = await this.prisma.contract.findFirst({
        where: { id: cursor, projectId },
        select: { id: true, parentContractId: true },
      });
      if (!parent || ids.has(parent.id)) break;
      ids.add(parent.id);
      cursor = parent.parentContractId ?? null;
    }
    // 2) 向下补齐所有层级的补充协议
    let frontier = [...ids];
    for (let depth = 0; frontier.length && depth < 32; depth += 1) {
      const children: Array<{ id: string }> = await this.prisma.contract.findMany({
        where: { projectId, parentContractId: { in: frontier } },
        select: { id: true },
      });
      frontier = children.map((c) => c.id).filter((id) => !ids.has(id));
      for (const id of frontier) ids.add(id);
    }
    return [...ids];
  }
}

/** 日期上界按「当天收尾」处理：库里 payDate/settleDate 可能带时分秒，直接比 00:00:00 会漏掉末日 */
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** 日期下界按「当天零点」处理（与 endOfDay 对称，避免 12:30 的起始日把上午数据漏掉） */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
