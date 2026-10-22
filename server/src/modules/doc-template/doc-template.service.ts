import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { pickFields } from '../../common/pick-fields';
import { assertVersion } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';
import { buildPaymentDocValues } from './doc-template-vars';
import { renderTemplateExcel } from './doc-excel';
import { isExcelTemplateFileName, normalizeDocTemplateFileKey } from './doc-template-file';
import { StorageService } from '../../common/services/storage.service';

/** Excel 单据模板的可写字段（fileUrl/fileName 经校验与归一后写入） */
const DOC_EXCEL_FIELDS = ['name', 'categoryCode', 'tags', 'status', 'fileUrl', 'fileName', 'createdBy'];

/** 状态只接受 0/1（Boolean 也兼容：true→1、false→0） */
function normalizeStatus(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (n !== 0 && n !== 1) throw new BadRequestException('状态只能为 0（停用）或 1（启用）');
  return n;
}

/**
 * **单据模板**（业务口径 2026-10-16）：基础信息管理下管理**五类**单据的 **Excel 模板**
 * —— 结算单 / 总结算单 / 保理单 / 逾期利息 / 付款单。
 *
 * 存储**复用 `ContractTemplate` 表**，但分类走**独立字典** `doc_template_category`：混用
 * `contract_template_category` 会让"合同模板"的分类下拉里冒出"付款单"。
 *
 * 生成路径（业务 2026-10-17：Word → Excel）：**付款单**与**总结算单**已接；
 * 其余三类本期只做模板存放。模板文件只接受 **.xlsx**（`.xlsm` 的宏在 ExcelJS 写出时会丢失，
 * 静默丢宏不可接受），落库的是 `StorageService` **相对键**（不是 `/api/files/...` 公开 URL）。
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
    if (query.status !== undefined && query.status !== '') where.status = normalizeStatus(query.status, 1);
    const rows = await this.prisma.contractTemplate.findMany({
      where,
      orderBy: [{ categoryCode: 'asc' }, { createdAt: 'desc' }],
    });
    // 历史数据可能把公开 URL 存进了 fileUrl：读取时统一归一成相对键（对前端透明）
    return rows.map((r) => this.serialize(r));
  }

  /** 单据模板的五类分类编码（取自字典，避免在这里再抄一份） */
  private async categoryCodes(): Promise<string[]> {
    const items = await this.dict.options('doc_template_category');
    return items.map((i: any) => i.itemCode);
  }

  /**
   * 单据模板详情。**必须限定在 `doc_template_category` 五类之内**（第 21 轮审计）：
   * 单据模板与合同模板**共用 `ContractTemplate` 表**，而 `update`/`remove` 都以本方法为准。
   * 原来裸 `findUnique({ id })`：把任意**合同模板**的 id 传进来，`PUT/DELETE /doc-templates/:id`
   * 就能改/删掉合同模板（跨模块越权，且合同模板里存着正文占位符与归档口径）。
   */
  async findOne(id: string) {
    const tpl: any = await this.prisma.contractTemplate.findUnique({ where: { id } });
    if (!tpl) throw new NotFoundException('单据模板不存在');
    const codes = await this.categoryCodes();
    if (!codes.includes(String(tpl.categoryCode ?? ''))) throw new NotFoundException('单据模板不存在');
    return this.serialize(tpl);
  }

  /** 输出前把 fileUrl 归一成相对键（兼容历史 `/api/files/...` 与双前缀数据） */
  private serialize<T extends { fileUrl?: string | null }>(row: T): T {
    return row.fileUrl ? { ...row, fileUrl: normalizeDocTemplateFileKey(row.fileUrl) } : row;
  }

  private async assertCategory(code: unknown) {
    await this.dict.validate('doc_template_category', code);
    if (code === undefined || code === null || code === '') {
      throw new BadRequestException('请选择单据模板分类');
    }
  }

  /**
   * 校验并返回模板文件的**相对键**：
   * 必须存在、扩展名是 `.xlsx`、且能被 ExcelJS 解析（拒绝空工作簿/损坏文件）。
   * 兼容调用方传裸键、`/api/files/...`、完整 URL（历史前端存的是 URL）。
   */
  private async assertExcelTemplate(
    input: { fileUrl?: unknown; fileName?: unknown },
    existing?: { fileUrl?: string | null; fileName?: string | null },
  ): Promise<string> {
    const key = normalizeDocTemplateFileKey(input.fileUrl !== undefined ? input.fileUrl : existing?.fileUrl);
    if (!key) throw new BadRequestException('请上传 Excel 模板文件（.xlsx）');
    const name = String(input.fileName ?? existing?.fileName ?? key);
    if (!isExcelTemplateFileName(name)) {
      throw new BadRequestException('单据模板必须上传 Excel 工作簿（.xlsx）；.xlsm 的宏会在生成时丢失');
    }
    if (!(await this.storageService.exists(key))) {
      throw new BadRequestException('模板文件不存在或已被清理，请重新上传');
    }
    const buffer = await this.storageService.read(key);
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as any);
      if (!wb.worksheets.length) throw new Error('empty workbook');
    } catch {
      throw new BadRequestException('模板文件无法解析，请确认是有效的 Excel 工作簿（.xlsx）后重新上传');
    }
    return key;
  }

  async create(data: any, projectId: string, user: any) {
    await this.assertCategory(data?.categoryCode);
    if (!data?.name) throw new BadRequestException('模板名称不能为空');
    const fileUrl = await this.assertExcelTemplate({ fileUrl: data?.fileUrl, fileName: data?.fileName });
    const payload: any = pickFields(data, DOC_EXCEL_FIELDS, { label: '单据模板' });
    // 业务 2026-10-17：单据模板**全项目通用** → 一律落全局（projectId=null）；
    // 模板内容为**上传的 Excel 文件**（fileUrl 只存相对键；历史富文本 content 字段保留但不再使用）
    return this.prisma.contractTemplate.create({
      data: {
        ...payload,
        fileUrl,
        fileName: data?.fileName ? String(data.fileName) : fileUrl.split('/').pop() || null,
        status: normalizeStatus(data?.status, 1),
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
    if (data.fileUrl !== undefined || data.fileName !== undefined) {
      payload.fileUrl = await this.assertExcelTemplate(
        { fileUrl: data.fileUrl, fileName: data.fileName },
        before,
      );
      if (data.fileName !== undefined) payload.fileName = data.fileName ? String(data.fileName) : null;
    } else if (before.fileUrl) {
      // 未换文件：把历史 URL 形态顺手归一，避免继续留在库里
      payload.fileUrl = normalizeDocTemplateFileKey(before.fileUrl);
    }
    if (data.status !== undefined) payload.status = normalizeStatus(data.status, before.status);
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

    // 历史数据可能存的是公开 URL；统一取相对键再读盘
    const fileKey = normalizeDocTemplateFileKey((template as any).fileUrl);
    if (!fileKey) {
      throw new BadRequestException(
        `单据模板「${(template as any).name}」未上传 Excel 文件：请到「基础信息管理 → 单据模板」编辑并上传 .xlsx。`,
      );
    }

    const tplBuffer = await this.storageService.read(fileKey);
    let buffer: Buffer;
    try {
      buffer = await renderTemplateExcel({
        template: tplBuffer,
        values: opts.values,
        tables: opts.tables,
      });
    } catch {
      throw new BadRequestException(
        `模板文件无法解析，请确认是有效的 Excel 工作簿（.xlsx）后重新上传：` +
          `「${(template as any).name}」`,
      );
    }

    // 替换后扫描残留占位符（读回来扫一遍代价可接受；单据都是小文件）
    const check = new ExcelJS.Workbook();
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
  async renderPaymentProcedure(procedureId: string, templateId?: string, projectId?: string) {
    /**
     * 必须按项目过滤（第 9 轮审计）：付款单里载明金额、供应商与银行账号，
     * 原来只按 procedureId 直取 → 任何有 	emplate:view 的人换个 id 就能下载别项目的付款单。
     */
    const procedure: any = await this.prisma.paymentProcedure.findFirst({
      where: { id: procedureId, ...(projectId ? { projectId } : {}) },
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
