import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import HTMLtoDOCX from 'html-to-docx';
import fontkit from '@pdf-lib/fontkit';
import { StorageService } from '../../common/services/storage.service';
import { round2 } from '../../common/utils/money';
import { paidPaymentWhere } from '../../constants/statuses';
import { AiQuota } from './ai-quota';
import { type AiConfig } from './ai-config';
import { AiSettingService } from './ai-setting.service';
import { FieldResolverService } from './field-resolver.service';
import { chatText, LlmError } from './llm-client';
import { renderReportPdf } from './report-pdf';
import { collectionFontCount, extractFontFromCollection, hasCffOutlines, isFontCollection } from './ttc-font';
import {
  REPORT_KINDS,
  auditReport,
  deltaOf,
  markdownToHtml,
  type ReportDelta,
  type ReportFacts,
  type ReportKind,
  type ReportWindow,
} from './report-facts';
import { buildReportMessages } from './report-prompt';
import { templateSections } from './report-templates';

export interface AiReportResult {
  kind: ReportKind;
  label: string;
  /** 该材料的公文骨架（节标题），前端照着展示 */
  sections: string[];
  period: { from: string; to: string; label: string };
  /** 对比期（环比基数） */
  comparePeriod: { from: string; to: string; label: string };
  /** 生成的 Markdown 正文 */
  markdown: string;
  /** 事实清单（前端可折叠展示，便于核对数字来源） */
  facts: ReportFacts;
  /** 产出里出现、但事实清单里找不到的数字——必须让人看见 */
  unknownNumbers: string[];
  /** 数据侧的提醒（例如区间内没有日报） */
  warnings: string[];
  /** 材料里缺少模板要求的节标题（模型偶尔会漏） */
  missingSections: string[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ExportInput {
  markdown?: string;
  title?: string;
  /** 页眉（公司名/项目部），可选；空则只放标题 */
  header?: string;
  /** 页脚说明（默认放生成时间） */
  footer?: string;
}

const YMD = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const iso = (v: unknown): string | null => (v ? YMD(new Date(v as string)) : null);

/** 区间内发生的量（不含项目累计） */
type WindowNumbers = Omit<ReportWindow, 'period'>;

/**
 * 汇报材料（三期）：**程序给事实、模型给文字**。
 *
 * 为什么不把库结构/明细直接丢给模型让它自己算：
 * 它会算错，还会算得很自信。这里先把区间内的事实聚合好（口径与台账、防超结/防超付一致），
 * 环比也一并算好（`deltaOf`，上期为 0 时返回 null 而不是 Infinity），
 * 模型只负责组织语言；产出后再把每个数字回查一遍（`auditReport`）。
 */
@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private prisma: PrismaClient,
    private quota: AiQuota,
    private resolver: FieldResolverService,
    private storage: StorageService,
    /** 配置统一走「系统管理 → AI 信息登记」：页面登记 > 环境变量（见 ai-config.ts） */
    private setting: AiSettingService,
  ) {}

  /** 解析到的中文字体字节（进程内缓存；字体文件不会变） */
  private fontCache: Uint8Array | null = null;

  private async config(): Promise<AiConfig> {
    return this.setting.resolve();
  }

  async generate(
    input: { kind?: string; from?: string; to?: string; extra?: string },
    projectId: string,
    userId: string,
  ): Promise<AiReportResult> {
    const kind = (input?.kind || 'monthly') as ReportKind;
    if (!REPORT_KINDS[kind]) throw new BadRequestException(`不支持的材料类型：${input?.kind}`);
    const cfg = await this.config();
    if (!cfg.enabled) throw new BadRequestException('AI 未配置（接口地址 / API Key / 模型名），无法生成材料：请让管理员到「系统管理 → AI 信息登记」填写');

    const { from, to } = this.resolvePeriod(input?.from, input?.to);
    const cmp = this.comparePeriod(from, to);
    const facts = await this.collectFacts(projectId, { from, to }, cmp);

    this.quota.consume(userId, cfg.hourlyLimitPerUser);
    const res = await chatText(
      globalThis.fetch as any,
      {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: Math.max(cfg.timeoutMs, 90000),
        temperature: 0.3,
        maxTokens: cfg.maxTokens,
      },
      buildReportMessages({ kind, facts, extra: input?.extra }),
    ).catch((e: any) => {
      const msg = e instanceof LlmError ? e.message : String(e?.message || e);
      // 失败不占额度（2026-10-20 审计 P2）
      this.quota.refund(userId);
      this.logger.warn(`汇报材料生成失败：${msg}`);
      throw new BadRequestException(`生成失败：${msg}`);
    });

    const audit = auditReport(res.text, facts);
    const sections = templateSections(kind);
    const warnings = [...facts.risks];
    if (factNumbersEmpty(facts)) warnings.push('所选区间内没有数据，材料可能只有框架没有内容');
    const missingSections = sections.filter((s) => !res.text.includes(s));

    return {
      kind,
      label: REPORT_KINDS[kind].label,
      sections,
      period: facts.current.period,
      comparePeriod: facts.compare.period,
      markdown: res.text,
      facts,
      unknownNumbers: audit.unknown,
      warnings,
      missingSections,
      usage: res.usage,
    };
  }

  /** 导出 docx：只做格式转换，不重新生成内容（导出与页面看到的必须是同一份） */
  async exportDocx(input: ExportInput): Promise<{ buffer: Buffer; fileName: string }> {
    const md = this.requireMarkdown(input);
    const html = markdownToHtml(md);
    const title = this.fileBaseName(input?.title);
    const header = `<p style="font-size:9pt;color:#666;text-align:center;">${escapeInline(
      input?.header || title,
    )}</p>`;
    const footer = `<p style="font-size:9pt;color:#666;text-align:center;">${escapeInline(
      input?.footer || '本材料由系统数据自动汇总生成，请核对后使用',
    )}</p>`;
    const buffer = (await HTMLtoDOCX(html, header, {
      footer: true,
      pageNumber: true,
      font: 'SimSun',
      fontSize: 21,
      table: { row: { cantSplit: true } },
      margins: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
    }, footer)) as Buffer;
    return { buffer, fileName: `${title}.docx` };
  }

  /**
   * 导出 PDF。中文必须靠内嵌字体——pdf-lib 自带的 14 个标准字体没有汉字，
   * 一个都找不到时明确报错，而不是导出一份满页方框的 PDF。
   */
  async exportPdf(input: ExportInput): Promise<{ buffer: Buffer; fileName: string }> {
    const md = this.requireMarkdown(input);
    const font = await this.pdfFont();
    const buffer = await renderReportPdf(md, {
      font,
      title: this.fileBaseName(input?.title),
      header: input?.header,
      footer: input?.footer,
    });
    return { buffer, fileName: `${this.fileBaseName(input?.title)}.pdf` };
  }

  /**
   * 找一个能用的中文字体。
   * 逐个候选**试着真嵌一次**再定，而不是看到文件存在就当能用——否则导出会在最后一步才失败。
   * `.ttc` 字体集（Debian 的 noto / wqy / arphic 都是）pdf-lib 直接嵌会失败，
   * 先用 `extractFontFromCollection()` 把里面每一支拆成独立字体再试。
   */
  async pdfFont(): Promise<Uint8Array> {
    if (this.fontCache) return this.fontCache;
    const { PDFDocument } = await import('pdf-lib');
    const candidates = [
      process.env.AI_PDF_FONT,
      '/Library/Fonts/Arial Unicode.ttf',
      '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
      // TrueType(glyf) 中文字体优先：wqy / arphic 都是 glyf，pdf-lib 能正确嵌入
      '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
      '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
      '/usr/share/fonts/truetype/arphic/uming.ttc',
      '/usr/share/fonts/truetype/arphic/ukai.ttc',
      // CFF 类（Noto CJK / 思源）放最后：实测嵌入后是乱码，只在没别的字体时才会被排除掉
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    ].filter(Boolean) as string[];
    let cffSkipped = 0;
    for (const path of candidates) {
      try {
        const raw = new Uint8Array(await this.storage.readLocalFile(path));
        const variants = isFontCollection(raw)
          ? Array.from({ length: Math.min(collectionFontCount(raw), 8) }, (_, i) => {
              try {
                return extractFontFromCollection(raw, i);
              } catch {
                return null;
              }
            }).filter((v): v is Uint8Array => !!v)
          : [raw];
        for (const bytes of variants) {
          // CID-keyed CFF 会让 pdf-lib 输出乱码，必须跳过（宁可报错也不给乱码文件）
          if (hasCffOutlines(bytes)) {
            cffSkipped += 1;
            continue;
          }
          try {
            const probe = await PDFDocument.create();
            probe.registerFontkit(fontkit);
            await probe.embedFont(bytes, { subset: true });
            this.fontCache = bytes;
            return bytes;
          } catch {
            // 这一支不行，试下一支
          }
        }
      } catch {
        // 换下一个候选文件
      }
    }
    throw new BadRequestException(
      cffSkipped
        ? `服务器上的中文字体都是 CFF/PostScript 轮廓（${cffSkipped} 个），pdf-lib 只能正确嵌入 TrueType 字体，导出的 PDF 会变乱码，因此已中止。` +
            '请安装 fonts-wqy-zenhei（或 fonts-arphic-uming），或用 AI_PDF_FONT 指定一个 .ttf/.ttc 中文字体路径；也可以先导出 Word。'
        : '服务器没有可用的中文字体，无法导出 PDF：请安装 fonts-wqy-zenhei，或用 AI_PDF_FONT 指定 .ttf/.ttc 中文字体路径（也可以先导出 Word）',
    );
  }

  private requireMarkdown(input: ExportInput): string {
    const md = String(input?.markdown || '').trim();
    if (!md) throw new BadRequestException('没有可导出的内容');
    if (md.length > 100000) throw new BadRequestException('内容过长（>10 万字符），请分段导出');
    return md;
  }

  private fileBaseName(title?: string): string {
    return String(title || '汇报材料').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  /**
   * 统计区间：`YYYY-MM-DD` 按**本地零点**解析。
   *
   * ⚠️ 不能写 `new Date(from)`：ISO 日期串会按 **UTC** 解析，容器 TZ 是 Asia/Shanghai 时
   * 实际起点变成本地 08:00，首日 00:00–08:00 的结算/付款/开票/日报静默漏计，
   * 而标题写的是整天（2026-10-20 审计 P1-5）。补上 `T00:00:00` 走本地时区解析。
   */
  private resolvePeriod(from?: string, to?: string): { from: Date; to: Date } {
    const now = new Date();
    const parseDay = (v: string, label: string): Date => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException(`${label}格式应为 YYYY-MM-DD`);
      const d = new Date(`${v}T00:00:00`);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label}不是有效日期：${v}`);
      return d;
    };
    const start = from ? parseDay(from, '开始日期') : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = to ? parseDay(to, '结束日期') : now;
    if (start > end) throw new BadRequestException('开始日期不能晚于结束日期');
    // 含当天：结束日按 23:59:59.999 取
    const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
    return { from: start, to: endOfDay };
  }

  /** 对比期 = 紧邻本期之前、长度相同的一段（本期 10/1~10/19 → 上期 9/12~9/30） */
  private comparePeriod(from: Date, to: Date): { from: Date; to: Date } {
    const spanMs = to.getTime() - from.getTime();
    const cmpTo = new Date(from.getTime() - 1);
    const cmpFrom = new Date(cmpTo.getTime() - spanMs);
    return { from: cmpFrom, to: cmpTo };
  }

  private async windowNumbers(projectId: string, from: Date, to: Date): Promise<WindowNumbers> {
    const [signed, settlements, payments, invoices, daily] = await Promise.all([
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
    return {
      contractsSigned: signed.length,
      contractsSignedAmount: sum(signed, (c) => Number(c.amount || 0) + Number(c.changeAmount || 0)),
      settlementCount: settlements.length,
      settlementAmount: sum(settlements, (r) => r.actualAmount ?? r.amount),
      paymentCount: payments.length,
      paymentAmount: sum(payments, (r) => r.amount),
      invoiceCount: invoices.length,
      invoiceAmount: sum(invoices, (r) => r.amountWithTax),
      dailyReports: daily,
    };
  }

  private async collectFacts(
    projectId: string,
    current: { from: Date; to: Date },
    compare: { from: Date; to: Date },
  ): Promise<ReportFacts> {
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

    const [stats, contracts, now, prev] = await Promise.all([
      this.resolver.projectStats(projectId),
      this.prisma.contract.findMany({ where: { projectId }, select: { execStatus: true } }),
      this.windowNumbers(projectId, current.from, current.to),
      this.windowNumbers(projectId, compare.from, compare.to),
    ]);

    const facts: ReportFacts = {
      project: {
        name: project.name,
        code: project.code,
        manager: project.projectManager ?? null,
        startDate: iso(project.startDate),
        endDate: iso(project.endDate),
        selfContractAmount: project.selfContractAmount === null ? null : Number(project.selfContractAmount),
      },
      current: {
        period: { from: YMD(current.from), to: YMD(current.to), label: `${YMD(current.from)} ~ ${YMD(current.to)}` },
        ...now,
      },
      compare: {
        period: { from: YMD(compare.from), to: YMD(compare.to), label: `${YMD(compare.from)} ~ ${YMD(compare.to)}` },
        ...prev,
      },
      totals: {
        contracts: contracts.length,
        executing: contracts.filter((c) => c.execStatus === 'EXECUTING').length,
        contractAmount: stats.contractAmountTotal,
        settlementAmount: stats.settlementAmountTotal,
        paymentAmount: stats.paymentAmountTotal,
        invoiceAmount: stats.invoiceAmountTotal,
        unpaid: stats.unpaidAmount,
      },
      deltas: {
        contractsSigned: deltaOf(now.contractsSigned, prev.contractsSigned),
        contractsSignedAmount: deltaOf(now.contractsSignedAmount, prev.contractsSignedAmount),
        settlementAmount: deltaOf(now.settlementAmount, prev.settlementAmount),
        paymentAmount: deltaOf(now.paymentAmount, prev.paymentAmount),
        invoiceAmount: deltaOf(now.invoiceAmount, prev.invoiceAmount),
        dailyReports: deltaOf(now.dailyReports, prev.dailyReports),
      },
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
    const t = f.totals;
    if (t.unpaid < 0) {
      risks.push(`累计付款已超过累计结算 ${Math.abs(t.unpaid).toFixed(2)} 元（应付未付为负），需核对是否存在重复付款`);
    } else if (t.unpaid > 0) {
      risks.push(`存在应付未付 ${t.unpaid.toFixed(2)} 元，需关注付款进度`);
    }
    if (t.settlementAmount > 0 && t.invoiceAmount < t.settlementAmount) {
      risks.push(
        `累计开票 ${t.invoiceAmount.toFixed(2)} 元低于累计结算 ${t.settlementAmount.toFixed(2)} 元，开票进度落后于结算`,
      );
    }
    if (f.current.dailyReports === 0) {
      risks.push('所选区间内没有日报记录，履约进度缺少数据支撑');
    }
    if (t.contracts > 0 && t.executing === 0) {
      risks.push('当前没有执行中的合同，请确认合同状态是否已全部办结');
    }
    const drop = (d: ReportDelta, name: string) => {
      if (d.pct !== null && d.pct <= -50 && d.prev > 0) {
        risks.push(`${name}环比下降 ${Math.abs(d.pct).toFixed(2)}%（上期 ${d.prev.toFixed(2)} → 本期 ${d.now.toFixed(2)}），需关注是否出现停滞`);
      }
    };
    drop(f.deltas.contractsSignedAmount, '新签合同金额');
    drop(f.deltas.paymentAmount, '付款金额');
    drop(f.deltas.dailyReports, '日报条数');
    return risks;
  }
}

const escapeInline = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** 区间内是否真的抓到了数据（全 0 说明材料只能写框架） */
function factNumbersEmpty(f: ReportFacts): boolean {
  const c = f.current;
  return (
    c.contractsSigned === 0 &&
    c.settlementCount === 0 &&
    c.paymentCount === 0 &&
    c.invoiceCount === 0 &&
    c.dailyReports === 0
  );
}


