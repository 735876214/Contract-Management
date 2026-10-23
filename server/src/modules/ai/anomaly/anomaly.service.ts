import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertPermission } from '../../../common/utils/assert-permission';
import { SysParamService } from '../../../common/services/sys-param.service';
import { AiQuota } from '../ai-quota';
import { AiSettingService } from '../ai-setting.service';
import { chatJson } from '../llm-client';
import {
  type Finding,
  type MaterialQtyRow,
  type PaymentAnomalyInput,
  type AnomalySummary,
  centsToYuan,
} from './anomaly-types.ts';
import { evaluatePaymentAnomalies } from './rules-payment.ts';
import { ANOMALY_PARAM_KEY_LIST, parseAnomalyConfig, type AnomalyConfig } from './anomaly-config.ts';
import {
  auditNarrative,
  buildAnomalyMessages,
  fallbackNarrative,
  type AnomalyNarrative,
} from './anomaly-prompt.ts';

/** 合同链上溯上限（与 `contract-chain.ts` 的 CHAIN_MAX_DEPTH 同口径，防环） */
const CHAIN_MAX_DEPTH = 8;

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
      const messages = buildAnomalyMessages({
        period: result.period,
        sample,
        toleranceText: `金额容差 ${centsToYuan(cfg.tolerances.amount)} 元；数量容差 +${cfg.tolerances.qtyPct}%；明细重合度 ${cfg.tolerances.jaccard}`,
        evaluation,
      });
      const res = await chatJson(globalThis.fetch as any, {
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey,
        model: ai.model,
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

      const unknown = auditNarrative(narrative, evaluation);
      if (unknown.length) {
        // 对账失败＝模型编了数字，一律丢弃（宁可用干巴巴的模板串，也不给人一份带假数字的结论）
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
    const from = query?.from ? new Date(query.from) : null;
    const to = query?.to ? new Date(query.to) : null;
    if (from && Number.isNaN(from.getTime())) throw new BadRequestException(`起始日期不合法：${query.from}`);
    if (to && Number.isNaN(to.getTime())) throw new BadRequestException(`结束日期不合法：${query.to}`);
    if (from && to && from > to) throw new BadRequestException('起始日期不能晚于结束日期');

    const contractId = query?.contractId || undefined;
    const contractWhere: any = { projectId, ...(contractId ? { id: contractId } : {}) };
    const scoped: any = { projectId, ...(contractId ? { contractId } : {}) };
    const dateWhere: any = from || to ? { settleDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};

    const [contracts, settlements, payments, invoices, procedures, receipts, finalSettlementItems, materialRows] =
      await Promise.all([
        this.prisma.contract.findMany({
          where: contractWhere,
          select: {
            id: true,
            parentContractId: true,
            code: true,
            name: true,
            amount: true,
            status: true,
            execStatus: true,
            ext: { select: { currentPayRatio: true } },
          },
        }),
        this.prisma.settlement.findMany({
          where: { ...scoped, ...dateWhere },
          select: {
            id: true,
            contractId: true,
            code: true,
            amount: true,
            actualAmount: true,
            settleDate: true,
            statusCode: true,
            items: { select: { materialBaseId: true, qty: true, totalWithTax: true } },
          },
          orderBy: [{ settleDate: 'asc' }, { createdAt: 'asc' }],
        }),
        this.prisma.paymentRecord.findMany({
          where: scoped,
          select: { id: true, contractId: true, amount: true, payDate: true, payMonth: true, statusCode: true },
          orderBy: [{ payDate: 'asc' }, { createdAt: 'asc' }],
        }),
        this.prisma.invoice.findMany({
          where: {
            projectId,
            settlementId: { not: null },
            ...(contractId ? { settlement: { contractId } } : {}),
          },
          select: { id: true, settlementId: true, amountWithTax: true, statusCode: true, invoiceNo: true },
        }),
        this.prisma.paymentProcedure.findMany({
          where: scoped,
          select: {
            id: true,
            code: true,
            contractId: true,
            settleCumAmount: true,
            paidCumAmount: true,
            payDate: true,
          },
          orderBy: [{ payDate: 'asc' }, { createdAt: 'asc' }],
        }),
        this.prisma.receiptOrder.findMany({
          where: { projectId, settlementId: { not: null } },
          select: { id: true, settlementId: true, orderDate: true },
        }),
        this.prisma.finalSettlementItem.findMany({
          where: { finalSettlement: { projectId } },
          select: { id: true, finalSettlementId: true, settlementId: true, settleMonth: true, amount: true },
        }),
        this.prisma.contractMaterial.findMany({
          where: { contract: { projectId } },
          select: { contractId: true, materialBaseId: true, qty: true, materialBase: { select: { name: true } } },
        }),
      ]);

    // 合同链清单量：以**链根**为键聚合（与 `chainMaterialQty` 同口径：链根 + 直接补充协议）
    const rootOf = this.chainRootResolver(contracts as any[]);
    const materialsByKey = new Map<string, MaterialQtyRow>();
    for (const row of materialRows as any[]) {
      const rootId = rootOf(String(row.contractId));
      if (!rootId) continue;
      const key = `${rootId}::${row.materialBaseId}`;
      const acc = materialsByKey.get(key);
      const qty = row.qty == null ? null : Number(row.qty);
      if (!acc) {
        materialsByKey.set(key, {
          contractId: rootId,
          materialBaseId: row.materialBaseId,
          qty: qty ?? undefined,
          name: row.materialBase?.name ?? null,
        });
      } else if (qty != null) {
        // 求和用 Number 是安全的：这里是「清单暂定数量」，只用于百分比上限判定，
        // 真正需要分位精度的金额比较全部走 bigint（见 rules-payment.ts）
        acc.qty = Number(acc.qty ?? 0) + qty;
      }
    }

    return {
      input: {
        contracts: (contracts as any[]).map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          amount: c.amount,
          status: c.status,
          execStatus: c.execStatus,
          currentPayRatio: c.ext?.currentPayRatio ?? null,
        })),
        settlements: settlements as any,
        payments: payments as any,
        invoices: invoices as any,
        procedures: procedures as any,
        receipts: receipts as any,
        finalSettlementItems: finalSettlementItems as any,
        contractMaterials: [...materialsByKey.values()],
      },
      sample: {
        合同: contracts.length,
        结算单: settlements.length,
        付款: payments.length,
        发票: invoices.length,
        付款手续: procedures.length,
        收领单: receipts.length,
        终期结算明细: finalSettlementItems.length,
        清单物资行: materialRows.length,
      },
    };
  }

  /** 合同 id → 链根 id（防环、深度上限 8；不在集合里的返回 null） */
  private chainRootResolver(contracts: any[]): (id: string) => string | null {
    const byId = new Map<string, any>(contracts.map((c) => [String(c.id), c]));
    const memo = new Map<string, string | null>();
    return (id: string) => {
      if (memo.has(id)) return memo.get(id)!;
      let cur = byId.get(id);
      if (!cur) {
        memo.set(id, null);
        return null;
      }
      for (let depth = 0; depth < CHAIN_MAX_DEPTH; depth++) {
        const parentId = cur.parentContractId ? String(cur.parentContractId) : '';
        if (!parentId || !byId.has(parentId)) break;
        cur = byId.get(parentId)!;
      }
      const rootId = String(cur.id);
      memo.set(id, rootId);
      return rootId;
    };
  }
}
