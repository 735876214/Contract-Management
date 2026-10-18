import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { StorageService } from '../../common/services/storage.service';
import { storageKeyFromUrl } from '../../common/utils/storage-url';
import { ARCHIVE_CATEGORIES, ARCHIVE_CATEGORY_BY_KEY } from '../../constants/archiveCategories';
import { LedgerService } from '../ledger/ledger.service';
import { SettlementService } from '../settlement/settlement.service';
import { InvoiceService } from '../invoice/invoice.service';
import { PaymentService } from '../payment/payment.service';
import { AssetService } from '../asset/asset.service';
import { DailyReportService } from '../daily-report/daily-report.service';
import { RepaymentService } from '../repayment/repayment.service';
import { FinanceService } from '../finance/finance.service';
import { CostService } from '../cost/cost.service';
import { MonthlyProfitLossService } from '../cost/monthly-profit-loss.service';
import { LaborReceivingService } from '../cost/labor-receiving.service';
import { periodKeyOf } from '../../common/utils/settlement-period';
import {
  type ArchiveFile,
  PLACEHOLDER_NAME,
  businessFileName,
  dedupePath,
  extOf,
  imagePdfName,
  periodDirOf,
  prefixedFileName,
  placeholderText,
  projectRootOf,
  sanitizeSegment,
} from './archive-naming';

/**
 * 项目资料归档（附件需求 2026-10-17）：按需求目录树收集真实附件 + 实时导出 Excel → 打包 ZIP。
 *
 * 三条硬口径（业务 2026-10-17 逐条确认，实现见 `archive-naming.ts` 的纯函数）：
 * - 真实附件**按业务字段重命名**（`供应商-物资-结算账期-单据名`），不改库里的键；
 * - **收领单/发票的图片统一转单页 PDF**（pdf-lib；jpg/png 均可嵌，其他扩展名原样保留）；
 * - **台账 Excel 实时导出**（直接调各 service 的导出函数拿 Buffer，不走 HTTP）。
 *
 * ⚠️ 项目隔离：每个收集函数都显式带 `projectId`（CLAUDE.md 铁律 3）。
 * ⚠️ 本类**不做**定时任务（仓库不引入调度器），只有手动触发的一键下载。
 */
@Injectable()
export class ArchiveService {
  constructor(
    private prisma: PrismaClient,
    private storage: StorageService,
    private ledgerService: LedgerService,
    private settlementService: SettlementService,
    private invoiceService: InvoiceService,
    private paymentService: PaymentService,
    private assetService: AssetService,
    private dailyReportService: DailyReportService,
    private repaymentService: RepaymentService,
    private financeService: FinanceService,
    private costService: CostService,
    private monthlyProfitLossService: MonthlyProfitLossService,
    private laborReceivingService: LaborReceivingService,
  ) {}

  /** 目录树（前端归档页）：每目录的文件数与明细 */
  async entries(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('项目不存在');
    const files = await this.collectAll(projectId, project.nameAbbr, project.name);
    const groups = ARCHIVE_CATEGORIES.map((c) => {
      const items = files.filter((f) => f.zipPath.startsWith(`${projectRootOf(project.nameAbbr, project.name)}/${c.dir}/`));
      return {
        key: c.key,
        dir: c.dir,
        label: c.label,
        sourceModule: c.sourceModule,
        count: items.length,
        items: items.map((f) => ({ fileName: f.fileName, zipPath: f.zipPath })),
      };
    });
    return { projectRoot: projectRootOf(project.nameAbbr, project.name), total: files.length, groups };
  }

  /** 打包下载；`scope=all` 或某分类 key */
  async download(projectId: string, scope: string | undefined, res: any) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('项目不存在');
    const root = projectRootOf(project.nameAbbr, project.name);
    let files = await this.collectAll(projectId, project.nameAbbr, project.name);
    let scopeLabel = '全部';
    if (scope && scope !== 'all') {
      const cat = ARCHIVE_CATEGORY_BY_KEY[scope];
      if (!cat) throw new NotFoundException(`未知的归档目录：${scope}`);
      files = files.filter((f) => f.zipPath.startsWith(`${root}/${cat.dir}/`));
      scopeLabel = cat.label;
    }

    const zip = new JSZip();
    const presentDirs = new Set<string>();
    for (const f of files) {
      if (f.buffer) zip.file(f.zipPath, f.buffer);
      else if (f.storageKey) {
        if (f.isImage) zip.file(f.zipPath, await this.imageToPdf(f.storageKey));
        else zip.file(f.zipPath, await this.storage.read(f.storageKey));
      }
      presentDirs.add(f.zipPath.split('/').slice(0, -1).join('/'));
    }
    // 空目录占位：保证包内目录结构与需求一致（用户要"目录看得见"）
    const scopeDirs =
      scope && scope !== 'all' ? [ARCHIVE_CATEGORY_BY_KEY[scope].dir] : ARCHIVE_CATEGORIES.map((c) => c.dir);
    for (const dir of scopeDirs) {
      const fullDir = `${root}/${dir}`;
      if (!presentDirs.has(fullDir)) {
        const cat = ARCHIVE_CATEGORIES.find((c) => `${c.dir}` === dir);
        zip.file(`${fullDir}/${PLACEHOLDER_NAME}`, placeholderText(dir, cat?.label ?? dir));
      }
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const filename = `${root}-归档-${scopeLabel}-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    res.end(buffer);
  }

  /** 收集全部（Excel 动态生成 + 真实附件收集），注册表顺序即目录顺序 */
  private async collectAll(projectId: string, nameAbbr: string | null, name: string | null): Promise<ArchiveFile[]> {
    const root = projectRootOf(nameAbbr, name);
    const out: ArchiveFile[] = [];
    const used = new Set<string>();
    const push = (dir: string, fileName: string, meta: { storageKey?: string; buffer?: Buffer; isImage?: boolean }) => {
      const zipPath = dedupePath(used, `${root}/${dir}/${fileName}`);
      used.add(zipPath);
      out.push({ zipPath, fileName, ...meta });
    };

    for (const cat of ARCHIVE_CATEGORIES) {
      switch (cat.key) {
        case 'contract': {
          push(cat.dir, '合同台账.xlsx', { buffer: await this.ledgerService.export(projectId) });
          const contracts = await this.prisma.contract.findMany({
            where: { projectId },
            select: {
              id: true, code: true, signedFilePath: true, signedFileName: true,
              attachments: { select: { fileName: true, url: true } },
            },
          });
          for (const c of contracts) {
            if (c.signedFilePath) {
              push(cat.dir, prefixedFileName(c.code || '合同', c.signedFileName || '签章合同.pdf'), {
                storageKey: c.signedFilePath,
              });
            }
            for (const a of c.attachments) {
              push(cat.dir, prefixedFileName(c.code || '合同', a.fileName), { storageKey: this.keyOf(a.url) });
            }
          }
          break;
        }
        case 'settle-ledger':
          push(cat.dir, '结算台账.xlsx', { buffer: await this.settlementService.exportLedger(projectId) });
          break;
        case 'daily-asset':
          push(cat.dir, '总日报.xlsx', { buffer: await this.dailyReportService.export(projectId) });
          const assetRes = await this.assetService.export(projectId);
          push(cat.dir, '资产台账.xlsx', { buffer: Buffer.from((assetRes as any).buffer as unknown as ArrayBuffer) });
          break;
        case 'receipt-scan': {
          const orders = await this.prisma.receiptOrder.findMany({
            where: { projectId, scanUrl: { not: null } },
            select: {
              id: true, scanUrl: true, scanFileName: true, orderDate: true, settlementId: true,
              materialContractNo: true,
              details: { select: { materialName: true }, take: 1 },
              supplier: { select: { name: true } },
              settlement: { select: { settleDate: true } },
            },
          });
          for (const o of orders) {
            const supplier = o.supplier?.name || '-';
            const material = o.details[0]?.materialName || o.materialContractNo || '-';
            const period = this.periodOf(o.settlement?.settleDate ?? o.orderDate, projectId);
            push(cat.dir, businessFileName({ supplier, material, period, docName: '收领单' }, true), {
              storageKey: o.scanUrl!,
              isImage: this.isImageKey(o.scanFileName || o.scanUrl!),
            });
          }
          break;
        }
        case 'settle-monthly': {
          const settlements = await this.prisma.settlement.findMany({
            where: { projectId, NOT: { statusCode: 'DRAFT' } },
            select: { settleDate: true },
          });
          // 账期目录：`2026.1` → `2026年1月`（需求原例；`sanitizeSegment` 清掉 Date.toString 的非法字符之外，
          // 这里必须在收集期就转成中文月——Date.toString 含 `:` 等字符，靠清洗会出现 "Sat_Feb_28_2026" 这种目录）
          const periods = Array.from(
            new Set(settlements.map((s) => periodDirOf(this.periodLabelOf(s.settleDate as any)))),
          );
          for (const p of periods) {
            push(`${cat.dir}/${p}`, '结算单.xlsx', {
              buffer: await this.settlementService.exportLedger(projectId),
            });
          }
          break;
        }
        case 'settle-final': {
          const finals = await this.prisma.finalSettlement.findMany({
            where: { projectId },
            select: {
              id: true, code: true, attachmentUrl: true, attachmentName: true,
              contract: { select: { name: true, supplier: { select: { name: true } } } },
            },
          });
          for (const f of finals) {
            const supplier = f.contract?.supplier?.name || '-';
            const contractName = f.contract?.name || f.code || '-';
            push(cat.dir, `${sanitizeSegment(supplier)}-${sanitizeSegment(contractName)}-总结算书.xlsx`, {
              buffer: await this.settlementService.exportLedger(projectId),
            });
            if (f.attachmentUrl) {
              push(cat.dir, prefixedFileName(`${sanitizeSegment(supplier)}-${sanitizeSegment(contractName)}`, f.attachmentName || '总结算书附件'), {
                storageKey: this.keyOf(f.attachmentUrl),
              });
            }
          }
          break;
        }
        case 'sub-receiving': {
          // 分包单位领用月度汇总（2026-10-17 第三批替换旧手工台账）：
          // 分包单位领用**单据**（一单 = 分包单位×结算期）：按单导出三表工作簿
          const docs = await this.prisma.laborReceivingDoc.findMany({
            where: { projectId },
            orderBy: [{ period: 'asc' }, { subcontractorName: 'asc' }],
          });
          for (const d of docs) {
            push(`${cat.dir}/${sanitizeSegment(d.subcontractorName)}`, `盘点领用表-${this.periodLabelOfPeriod(d.period)}.xlsx`, {
              buffer: await this.laborReceivingService.exportWorkbook(d.id),
            });
          }
          break;
        }
        case 'payment':
          push(cat.dir, '付款台账.xlsx', { buffer: await this.paymentService.exportRecords(projectId) });
          break;
        case 'invoice': {
          push(cat.dir, '发票台账.xlsx', { buffer: await this.invoiceService.export(projectId) });
          const invoices = await this.prisma.invoice.findMany({
            where: { projectId, imageUrl: { not: null } },
            select: {
              id: true, imageUrl: true, issuer: true, settlePeriod: true,
              contract: { select: { name: true, supplier: { select: { name: true } } } },
            },
          });
          for (const i of invoices) {
            const supplier = i.contract?.supplier?.name || i.issuer || '-';
            const material = i.contract?.name || '-';
            push(cat.dir, imagePdfName({ supplier, material, period: i.settlePeriod, docName: '发票汇总' }), {
              storageKey: this.keyOf(i.imageUrl!),
              isImage: this.isImageKey(i.imageUrl!),
            });
          }
          break;
        }
        case 'profit-loss': {
          // 月度盈亏分析（2026-10-17 第三批替换原手工台账）：一月一条，导出三 sheet 工作簿
          const records = await this.prisma.monthlyProfitLoss.findMany({
            where: { projectId },
            orderBy: { period: 'asc' },
            select: { id: true, period: true },
          });
          for (const rec of records) {
            const label = periodDirOf(rec.period);
            push(cat.dir, `降本、创效、主材盈亏分析表-${label}.xlsx`, {
              buffer: await this.monthlyProfitLossService.exportWorkbook(rec.id, projectId),
            });
          }
          break;
        }
        case 'finance-fund': {
          const contracts = await this.prisma.contract.findMany({
            where: { projectId },
            select: { id: true, code: true, name: true, supplier: { select: { name: true } } },
          });
          for (const c of contracts) {
            const factoring = await this.prisma.factoringCost.count({ where: { contractId: c.id } });
            const overdue = await this.prisma.overdueInterest.count({ where: { contractId: c.id } });
            const label = `${sanitizeSegment(c.supplier?.name || '-')}-${sanitizeSegment(c.name || c.code)}`;
            if (factoring > 0) {
              push(cat.dir, `保理费用-${label}.xlsx`, { buffer: await this.factoringBuffer(c.id) });
            }
            if (overdue > 0) {
              push(cat.dir, `逾期利息-${label}.xlsx`, { buffer: await this.overdueBuffer(c.id) });
            }
          }
          break;
        }
        case 'labor-auth': {
          push(cat.dir, '分包授权台账.xlsx', { buffer: await this.laborAuthBuffer(projectId) });
          const scs = await this.prisma.laborAuthLedger.findMany({
            where: { projectId },
            select: { id: true, subcontractorName: true, signedAuthFile: true },
          });
          for (const sc of scs) {
            if (sc.signedAuthFile) {
              push(cat.dir, prefixedFileName(sc.subcontractorName, '授权委托书' + extOf(sc.signedAuthFile)), {
                storageKey: this.keyOf(sc.signedAuthFile),
              });
            }
          }
          break;
        }
        case 'repayment':
          push(cat.dir, '还款协议.xlsx', { buffer: await this.repaymentService.export(projectId) });
          break;
      }
    }
    return out;
  }

  /** 各台账导出（Buffer 形态；简单台账按全量导出，分组交给目录） */
  private async laborAuthBuffer(projectId: string): Promise<Buffer> {
    return this.laborAuthExport(projectId);
  }

  private async factoringBuffer(contractId: string): Promise<Buffer> {
    const r = await this.financeService.exportFactoring(contractId);
    return Buffer.from(r.buffer as unknown as ArrayBuffer);
  }

  private async overdueBuffer(contractId: string): Promise<Buffer> {
    const r = await this.financeService.exportOverdue(contractId);
    return Buffer.from(r.buffer as unknown as ArrayBuffer);
  }

  /** 从 URL/键提取 StorageService 相对键（统一实现见 common/utils/storage-url.ts） */
  private keyOf(urlOrKey: string): string {
    return storageKeyFromUrl(urlOrKey);
  }

  private isImageKey(keyOrName: string): boolean {
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(extOf(keyOrName));
  }

  /** 归属结算期（账期）标签：优先结算单的结算日期，回退收领单日期；期 = 结算起始日 → 下月同日前一日 */
  private periodOf(date: Date | null, projectId: string): string {
    if (!date) return '-';
    const d = new Date(date);
    void projectId;
    return `${d.getFullYear()}.${d.getMonth() + 1}`;
  }

  /** Date → `YYYY.M`（账期标签；periodDirOf 再转成 `YYYY年M月` 目录） */
  /** 'YYYY-MM' → 'YYYY年M月'（分包单位领用汇总导出文件名用；认不出原样返回） */
  private periodLabelOfPeriod(period: string): string {
    const m = String(period).match(/^(\d{4})-(\d{2})$/);
    return m ? `${m[1]}年${Number(m[2])}月` : period;
  }

  private periodLabelOf(date: Date | null): string {
    if (!date) return '';
    const d = new Date(date);
    return `${d.getFullYear()}.${d.getMonth() + 1}`;
  }

  /** 图片 → 单页 PDF（修正 5：归档包不接受裸 jpg/png） */
  private async imageToPdf(storageKey: string): Promise<Buffer> {
    const raw = await this.storage.read(storageKey);
    const pdf = await PDFDocument.create();
    let embedded;
    try {
      embedded = await pdf.embedJpg(raw);
    } catch {
      embedded = await pdf.embedPng(raw);
    }
    // 页面尺寸 = 图片尺寸（1pt = 1px，扫描件足够）
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    return Buffer.from(await pdf.save());
  }

  /** 劳务台账 Excel（占位：批次 B 末尾由 labor.service.export 实现，见下） */
  private async laborAuthExport(projectId: string): Promise<Buffer> {
    const { exportLaborAuthWorkbook } = await import('../labor/labor-excel');
    return exportLaborAuthWorkbook(this.prisma, projectId, this.storage);
  }
}
