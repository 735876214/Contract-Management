import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import HTMLtoDOCX from 'html-to-docx';
import { pickFields } from '../../common/pick-fields';
import { assertVersion } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';
import { renderTemplate, pendingPlaceholders } from '../template/template-render';
import { buildPaymentDocValues } from './doc-template-vars';
import { buildItemsTable } from '../final-settlement/final-settlement-vars';
import { renderTemplateExcel } from './doc-excel';
import { StorageService } from '../../common/services/storage.service';

/** 可写字段（与合同模板同表，故字段名一致；该表没有 remark，别往里加） */
const TPL_FIELDS = ['name', 'categoryCode', 'tags', 'status', 'content', 'pageSetup', 'createdBy'];
/** Excel 单据模板的可写字段（fileUrl/fileName 由上传接口写入） */
const DOC_EXCEL_FIELDS = ['name', 'categoryCode', 'tags', 'status', 'fileUrl', 'fileName', 'createdBy'];

/**
 * **单据模板**（业务口径 2026-10-16）：基础信息管理下管理**五类**单据的 Word 模板
 * —— 结算单 / 总结算单 / 保理单 / 逾期利息 / 付款单。
 *
 * 存储**复用 `ContractTemplate` 表**（结构完全够用：名称/分类/内容/页面设置/启用状态/版本历史），
 * 但分类走**独立字典** `doc_template_category`：混用 `contract_template_category` 会让
 * "合同模板"的分类下拉里冒出"付款单"（两类东西的编辑与生成路径都不同）。
 *
 * 生成路径：本期只接**付款单**（其余四类随各自的单据模块接，避免一次性铺开五个渲染路径）；
 * 渲染复用零依赖的 `template-render.ts`（只认 `{{变量名}}`），变量取值见 `doc-template-vars.ts`。
 */
@Injectable()
export class DocTemplateService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private storageService: StorageService,
  ) {}

  async findAll(query: any = {}, projectId: string) {
    // 业务 2026-10-17：单据模板**全项目通用**——只看全局模板（projectId=null）；
    // 历史项目级模板（projectId 非空）仍可见（旧行不丢），但新建一律全局。
    const where: any = {
      OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])],
      categoryCode: query.categoryCode ? String(query.categoryCode) : { in: await this.categoryCodes() },
    };
    if (query.keyword) where.name = { contains: query.keyword };
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    return this.prisma.contractTemplate.findMany({
      where,
      orderBy: [{ categoryCode: 'asc' }, { createdAt: 'desc' }],
    });
  }

  /** 单据模板的五类分类编码（取自字典，避免在这里再抄一份） */
  private async categoryCodes(): Promise<string[]> {
    const items = await this.dict.options('doc_template_category');
    return items.map((i: any) => i.itemCode);
  }

  async findOne(id: string) {
    const tpl = await this.prisma.contractTemplate.findUnique({ where: { id } });
    if (!tpl) throw new NotFoundException('单据模板不存在');
    return tpl;
  }

  private async assertCategory(code: unknown) {
    await this.dict.validate('doc_template_category', code);
    if (code === undefined || code === null || code === '') {
      throw new BadRequestException('请选择单据模板分类');
    }
  }

  async create(data: any, projectId: string, user: any) {
    await this.assertCategory(data?.categoryCode);
    if (!data?.name) throw new BadRequestException('模板名称不能为空');
    // 业务 2026-10-17：单据模板**全项目通用** → 一律落全局（projectId=null）；
    // 模板内容为**上传的 Excel 文件**（fileUrl/fileName；历史富文本 content 字段保留但不再使用）
    return this.prisma.contractTemplate.create({
      data: {
        ...pickFields(data, DOC_EXCEL_FIELDS, { label: '单据模板' }),
        projectId: null,
        createdBy: user?.userId || user?.id || null,
      },
    });
  }

  async update(id: string, data: any) {
    const before: any = await this.findOne(id);
    assertVersion(before, data);
    if (data.categoryCode !== undefined) await this.assertCategory(data.categoryCode);
    const payload: any = pickFields(data, DOC_EXCEL_FIELDS, { label: '单据模板' });
    delete payload.version;
    delete payload.projectId;
    return this.prisma.contractTemplate.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.contractTemplate.delete({ where: { id } });
    return true;
  }

  /**
   * **通用 Excel 渲染入口**（业务 2026-10-17：单据模板改 Excel，五类单据都走这里）：
   * 按分类取模板（上传的 xlsx）→ 读模板扫单元格替换 `{{变量}}` → 出 xlsx。
   *
   * - 未指定 `templateId` 时取**启用中**该分类模板（全局）；
   * - 模板未上传 Excel（fileUrl 空）→ 报错并说清去哪儿配；
   * - 未取到值的占位符原样保留并记 warn（打印件上留着 `{{xxx}}` 一眼能看出缺什么）。
   */
  async renderExcel(opts: {
    categoryCode: string;
    categoryLabel: string;
    values: Record<string, string>;
    tables?: Record<string, string[][]>;
    templateId?: string;
    filename: string;
  }): Promise<{ buffer: Buffer; filename: string; pending: string[] }> {
    const template = opts.templateId
      ? await this.findOne(opts.templateId)
      : await this.prisma.contractTemplate.findFirst({
          where: { categoryCode: opts.categoryCode, status: 1 },
          orderBy: { createdAt: 'desc' },
        });
    if (!template) {
      throw new BadRequestException(
        `未找到启用中的「${opts.categoryLabel}」模板：请到「基础信息管理 → 单据模板」上传一张` +
          `（分类选「${opts.categoryLabel}」，Excel 文件）并启用。`,
      );
    }
    if (!(template as any).fileUrl) {
      throw new BadRequestException(
        `单据模板「${(template as any).name}」未上传 Excel 文件：请到「基础信息管理 → 单据模板」编辑并上传 .xlsx。`,
      );
    }

    const tplBuffer = await this.storageService.read((template as any).fileUrl);
    const buffer = await renderTemplateExcel({
      template: tplBuffer,
      values: opts.values,
      tables: opts.tables,
    });

    // 替换后扫描残留占位符（读回来扫一遍代价可接受；单据都是小文件）
    const wb = await import('exceljs');
    const check = new wb.Workbook();
    await check.xlsx.load(buffer as any);
    const pending = new Set<string>();
    for (const ws of check.worksheets) {
      ws.eachRow((row) => {
        row.eachCell((cell) => {
          const v = cell.value;
          const text = typeof v === 'string' ? v : Array.isArray((v as any)?.richText) ? (v as any).richText.map((t: any) => t.text).join('') : '';
          for (const m of String(text).matchAll(/\{\{\s*([^{}]{1,60}?)\s*\}\}/g)) pending.add(m[1]);
        });
      });
    }
    if (pending.size) {
      console.warn(`[doc-template] ${opts.categoryLabel}Excel 模板「${(template as any).name}」生成后仍有未替换占位符：${[...pending].join('、')}`);
    }
    return { buffer, filename: opts.filename, pending: [...pending] };
  }

  /**
   * **渲染付款单**（付款手续 → Excel）：取单据上的快照值 + 合同/供应商/项目，套模板生成 xlsx。
   * 业务 2026-10-17：生成路径 Word → Excel（单据数据来自表格、导出也是 Excel）。
   */
  async renderPaymentProcedure(procedureId: string, templateId?: string) {
    const procedure: any = await this.prisma.paymentProcedure.findUnique({
      where: { id: procedureId },
      include: {
        contract: { select: { id: true, code: true, name: true, supplierId: true } },
      },
    });
    if (!procedure) throw new NotFoundException('付款手续不存在');
    const supplier = procedure.supplierId
      ? await this.prisma.supplier.findUnique({ where: { id: procedure.supplierId }, select: { name: true } })
      : procedure.contract?.supplierId
        ? await this.prisma.supplier.findUnique({ where: { id: procedure.contract.supplierId }, select: { name: true } })
        : null;
    const project = await this.prisma.project.findUnique({
      where: { id: procedure.projectId },
      select: { name: true, nameAbbr: true, code: true },
    });

    const values = buildPaymentDocValues({ procedure, contract: procedure.contract, supplier, project });
    return this.renderExcel({
      categoryCode: 'PAYMENT',
      categoryLabel: '付款单',
      values,
      templateId,
      filename: `${procedure.code || '付款单'}.xlsx`,
    });
  }

  /**
   * **渲染总结算单**（总结算单 → Excel；明细表占位符按行展开）。
   * 业务 2026-10-17：生成路径 Word → Excel。
   */
  async renderFinalSettlement(opts: {
    doc: any;
    contract: any;
    project: any;
    supplier: any;
    values: Record<string, string>;
    templateId?: string;
    filename: string;
  }) {
    return this.renderExcel({
      categoryCode: 'FINAL_SETTLEMENT',
      categoryLabel: '总结算单',
      values: opts.values,
      tables: { 结算明细表: itemsToRows(opts.doc?.items || []) },
      templateId: opts.templateId,
      filename: opts.filename,
    });
  }

  /**
   * **旧 Word 渲染路径**（历史保留；五类单据已改 Excel，不再有调用方）。
   * 保留原因：历史合同正文导出（template.service）另有路径，与此无关；本函数留作回退。
   */
  async renderDocxLegacy(opts: {
    categoryCode: string;
    categoryLabel: string;
    projectId: string;
    values: Record<string, string>;
    tables?: Record<string, string>;
    templateId?: string;
    filename: string;
  }): Promise<{ buffer: Buffer; filename: string; pending: string[] }> {
    const template = opts.templateId
      ? await this.findOne(opts.templateId)
      : await this.prisma.contractTemplate.findFirst({
          where: {
            OR: [{ projectId: opts.projectId }, { projectId: null }],
            categoryCode: opts.categoryCode,
            status: 1,
          },
          orderBy: { createdAt: 'desc' },
        });
    if (!template) {
      throw new BadRequestException(
        `未找到启用中的「${opts.categoryLabel}」模板：请到「基础信息管理 → 单据模板」新增一张` +
          `（分类选「${opts.categoryLabel}」）并启用。`,
      );
    }

    const html = renderTemplate({ html: (template as any).content || '', values: opts.values, tables: opts.tables });
    const pending = pendingPlaceholders(html);
    if (pending.length) {
      console.warn(`[doc-template] ${opts.categoryLabel}模板「${template.name}」生成后仍有未替换占位符：${pending.join('、')}`);
    }
    // 与合同正文导出同一套 HTML → docx（表格整行不跨页）
    const buffer = (await HTMLtoDOCX(html, null, { table: { row: { cantSplit: true } } })) as Buffer;
    return { buffer, filename: opts.filename, pending };
  }

}

/** 总结算单明细行 → Excel 表格占位符的行数组（每行 = 列文本数组；首行为表头） */
function itemsToRows(items: any[]): string[][] {
  const head = ['结算月份', '结算金额(元)'];
  const rows = (items || []).map((i: any) => [String(i.settleMonth || ''), formatMoneyCell(i.amount)]);
  return [head, ...rows];
}

function formatMoneyCell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
}
