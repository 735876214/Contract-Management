import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import HTMLtoDOCX from 'html-to-docx';
import { paidPaymentWhere } from '../../constants/statuses';
import { AiQuota } from './ai-quota';
import { readAiConfig, type AiConfig } from './ai-config';
import { FieldResolverService } from './field-resolver.service';
import { chatText, LlmError } from './llm-client';
import { REPORT_KINDS, auditReport, markdownToHtml, type ReportFacts, type ReportKind } from './report-facts';
import { buildReportMessages } from './report-prompt';

export interface AiReportResult {
  kind: ReportKind;
  label: string;
  period: { from: string; to: string; label: string };
  /** 生成的 Markdown 正文 */
  markdown: string;
  /** 事实清单（前端可折叠展示，便于核对数字来源） */
  facts: ReportFacts;
  /** 产出里出现、但事实清单里找不到的数字——必须让人看见 */
  unknownNumbers: string[];
  /** 数据侧的提醒（例如区间内没有日报） */
  warnings: string[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

const YMD = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;
const iso = (v: unknown): string | null => (v ? YMD(new Date(v as string)) : null);

/**
 * 汇报材料（三期）：**程序给事实、模型给文字**。
 *
 * 为什么不把库结构/明细直接丢给模型让它自己算：
 * 它会算错，还会算得很自信。这里先把区间内的事实聚合好（口径与台账、防超结/防超付一致），
 * 模型只负责组织语言；产出后再把每个数字回查一遍（`auditReport`），编出来的数字会被标出来。
 */
@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private prisma: PrismaClient,
    private quota: AiQuota,
    private resolver: FieldResolverService,
  ) {}

  private config(): AiConfig {
    return readAiConfig(process.env as Record<string, string | undefined>);
  }

  async generate(
    input: { kind?: string; from?: string; to?: string; extra?: string },
    projectId: string,
    userId: string,
  ): Promise<AiReportResult> {
    const kind = (input?.kind || 'monthly') as ReportKind;
    if (!REPORT_KINDS[kind]) throw new BadRequestException(`不支持的材料类型：${input?.kind}`);
    const cfg = this.config();
    if (!cfg.enabled) throw new BadRequestException('AI 未配置（AI_BASE_URL / AI_API_KEY / AI_MODEL），无法生成材料');

    const { from, to } = this.resolvePeriod(input?.from, input?.to);
    const facts = await this.collectFacts(projectId, from, to);

    this.quota.consume(userId, cfg.hourlyLimitPerUser);
    const res = await chatText(
      globalThis.fetch as any,
      {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: Math.max(cfg.timeoutMs, 60000),
        temperature: 0.3,
        maxTokens: cfg.maxTokens,
      },
      buildReportMessages({ kind, facts, extra: input?.extra }),
    ).catch((e: any) => {
      const msg = e instanceof LlmError ? e.message : String(e?.message || e);
      this.logger.warn(`汇报材料生成失败：${msg}`);
      throw new BadRequestException(`生成失败：${msg}`);
    });

    const audit = auditReport(res.text, facts);
    const warnings = [...facts.risks];
    if (factNumbersEmpty(facts)) warnings.push('所选区间内没有数据，材料可能只有框架没有内容');

    return {
      kind,
      label: REPORT_KINDS[kind].label,
      period: facts.period,
      markdown: res.text,
      facts,
      unknownNumbers: audit.unknown,
      warnings,
      usage: res.usage,
    };
  }

  /** 导出 docx：只做格式转换，不重新生成内容（导出与页面看到的必须是同一份） */
  async exportDocx(input: { markdown?: string; title?: string }): Promise<{ buffer: Buffer; fileName: string }> {
    const md = String(input?.markdown || '').trim();
    if (!md) throw new BadRequestException('没有可导出的内容');
    if (md.length > 100000) throw new BadRequestException('内容过长（>10 万字符），请分段导出');
    const html = markdownToHtml(md);
    const buffer = (await HTMLtoDOCX(html, null, { table: { row: { cantSplit: true } } })) as Buffer;
    const title = String(input?.title || '汇报材料').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    return { buffer, fileName: `${title}.docx` };
  }

  private resolvePeriod(from?: string, to?: string): { from: Date; to: Date } {
    const now = new Date();
    const start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = to ? new Date(to) : now;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('时间范围格式应为 YYYY-MM-DD');
    }
    if (start > end) throw new BadRequestException('开始日期不能晚于结束日期');
    // 含当天：结束日按 23:59:59.999 取
    const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
    return { from: start, to: endOfDay };
  }

  private async collectFacts(projectId: string, from: Date, to: Date): Promise<ReportFacts> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: {
        name: true,
        code: true,
        projectManager: true,
        startDate: true,
        endDate: true,
        selfContractAmount: true,
      },
    });
    if (!project) throw new BadRequestException('项目不存在');

    const stats = await this.resolver.projectStats(projectId);
    const contractWhere = { projectId };

    const [contracts, signedInPeriod, settlementsIn, paymentsIn, invoicesIn, dailyIn] = await Promise.all([
      this.prisma.contract.findMany({ where: contractWhere, select: { id: true, execStatus: true } }),
      this.prisma.contract.findMany({
        where: { projectId, signDate: { gte: from, lte: to } },
        select: { amount: true, changeAmount: true },
      }),
      this.prisma.settlement.findMany({
        where: { projectId, createdAt: { gte: from, lte: to }, OR: [{ statusCode: null }, { statusCode: { not: 'DRAFT' } }] },
        select: { amount: true, actualAmount: true },
      }),
      this.prisma.paymentRecord.findMany({
        where: { projectId, ...paidPaymentWhere(), payDate: { gte: from, lte: to } },
        select: { amount: true },
      }),
      this.prisma.invoice.findMany({
        where: { projectId, invoiceDate: { gte: from, lte: to } },
        select: { amountWithTax: true },
      }),
      this.prisma.dailyReport.count({ where: { projectId, createdAt: { gte: from, lte: to } } }),
    ]);

    const sum = (rows: any[], pick: (r: any) => unknown): number =>
      round2(rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0));

    const facts: ReportFacts = {
      project: {
        name: project.name,
        code: project.code,
        manager: project.projectManager ?? null,
        startDate: iso(project.startDate),
        endDate: iso(project.endDate),
        selfContractAmount: project.selfContractAmount === null ? null : Number(project.selfContractAmount),
      },
      period: { from: YMD(from), to: YMD(to), label: `${YMD(from)} ~ ${YMD(to)}` },
      contracts: {
        total: contracts.length,
        executing: contracts.filter((c) => c.execStatus === 'EXECUTING').length,
        signedInPeriod: signedInPeriod.length,
        signedAmountInPeriod: sum(signedInPeriod, (c) => Number(c.amount || 0) + Number(c.changeAmount || 0)),
        totalAmount: stats.contractAmountTotal,
      },
      settlement: {
        countInPeriod: settlementsIn.length,
        amountInPeriod: sum(settlementsIn, (r) => r.actualAmount ?? r.amount),
        totalAmount: stats.settlementAmountTotal,
      },
      payment: {
        countInPeriod: paymentsIn.length,
        amountInPeriod: sum(paymentsIn, (r) => r.amount),
        totalAmount: stats.paymentAmountTotal,
        unpaid: stats.unpaidAmount,
      },
      invoice: {
        countInPeriod: invoicesIn.length,
        amountInPeriod: sum(invoicesIn, (r) => r.amountWithTax),
        totalAmount: stats.invoiceAmountTotal,
      },
      daily: { reportsInPeriod: dailyIn },
      risks: [],
    };

    facts.risks = this.detectRisks(facts);
    return facts;
  }

  /**
   * 风险点由**程序**判，不交给模型：这些都是明确的账实关系/数据缺口，
   * 用规则判得准、可解释，也方便以后加新规则。
   */
  private detectRisks(f: ReportFacts): string[] {
    const risks: string[] = [];
    if (f.payment.unpaid < 0) {
      risks.push(`累计付款已超过累计结算 ${Math.abs(f.payment.unpaid).toFixed(2)} 元（应付未付为负），需核对是否存在重复付款`);
    } else if (f.payment.unpaid > 0) {
      risks.push(`存在应付未付 ${f.payment.unpaid.toFixed(2)} 元，需关注付款进度`);
    }
    if (f.settlement.totalAmount > 0 && f.invoice.totalAmount < f.settlement.totalAmount) {
      risks.push(`累计开票 ${f.invoice.totalAmount.toFixed(2)} 元低于累计结算 ${f.settlement.totalAmount.toFixed(2)} 元，开票进度落后于结算`);
    }
    if (f.daily.reportsInPeriod === 0) {
      risks.push('所选区间内没有日报记录，履约进度缺少数据支撑');
    }
    if (f.contracts.total > 0 && f.contracts.executing === 0) {
      risks.push('当前没有执行中的合同，请确认合同状态是否已全部办结');
    }
    return risks;
  }
}

/** 区间内是否真的抓到了数据（全 0 说明材料只能写框架） */
function factNumbersEmpty(f: ReportFacts): boolean {
  return (
    f.contracts.signedInPeriod === 0 &&
    f.settlement.countInPeriod === 0 &&
    f.payment.countInPeriod === 0 &&
    f.invoice.countInPeriod === 0 &&
    f.daily.reportsInPeriod === 0
  );
}
