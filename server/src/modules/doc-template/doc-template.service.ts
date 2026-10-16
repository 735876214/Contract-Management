import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import HTMLtoDOCX from 'html-to-docx';
import { pickFields } from '../../common/pick-fields';
import { assertVersion } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';
import { renderTemplate, pendingPlaceholders } from '../template/template-render';
import { buildPaymentDocValues } from './doc-template-vars';

/** 可写字段（与合同模板同表，故字段名一致；该表没有 remark，别往里加） */
const TPL_FIELDS = ['name', 'categoryCode', 'tags', 'status', 'content', 'pageSetup', 'createdBy'];

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
  ) {}

  async findAll(query: any = {}, projectId: string) {
    const where: any = {
      OR: [{ projectId }, { projectId: null }],
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
    return this.prisma.contractTemplate.create({
      data: {
        ...pickFields(data, TPL_FIELDS, { label: '单据模板' }),
        projectId,
        createdBy: user?.userId || user?.id || null,
      },
    });
  }

  async update(id: string, data: any) {
    const before: any = await this.findOne(id);
    assertVersion(before, data);
    if (data.categoryCode !== undefined) await this.assertCategory(data.categoryCode);
    const payload: any = pickFields(data, TPL_FIELDS, { label: '单据模板' });
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
   * **通用渲染入口**：按分类取模板 → 用给定取值表渲染 → 出 docx。
   * 各单据模块（付款单、总结算单…）都走这里，别各写一份"找模板 + 渲染 + 转 docx"。
   *
   * - 未指定 `templateId` 时取该项目的**启用中**该分类模板；一张也没配就报错并说清去哪儿配
   *   （不内置兜底模板：打印出来的单据格式是业务资产，不该由代码偷偷决定）。
   * - 未取到值的占位符**原样保留**（`renderTemplate` 的行为）并记一条 warn：打印件上留着
   *   `{{xxx}}` 一眼就能看出缺什么，比静默留空好。
   * - `tables` 用于表格类占位符（如总结算单的月度明细表）。
   */
  async renderDocx(opts: {
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

  /**
   * **渲染付款单**（付款手续 → Word）：取单据上的快照值 + 合同/供应商/项目，套模板生成 docx。
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
    return this.renderDocx({
      categoryCode: 'PAYMENT',
      categoryLabel: '付款单',
      projectId: procedure.projectId,
      values,
      templateId,
      filename: `${procedure.code || '付款单'}.docx`,
    });
  }
}
