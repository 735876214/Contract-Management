import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';

const INVOICE_FIELDS = [
  'projectId', 'contractId', 'goodsCategory', 'settlePeriod', 'invoiceCode', 'invoiceNo',
  'typeCode', 'invoiceDate', 'issuer', 'receiver', 'amountBeforeTax', 'taxRate',
  'amountWithTax', 'receiveDate', 'reviewStatus', 'responsiblePerson', 'financeTransferStatus',
  'imageUrl', 'statusCode', 'remark',
];
const INVOICE_APPLY_FIELDS = [
  'projectId', 'contractId', 'typeCode', 'amount', 'taxRate', 'buyerInfo', 'statusCode', 'remark',
];

@Injectable()
export class InvoiceService {
  constructor(private prisma: PrismaClient, private dict: DictService, private excel: ExcelService) {}

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.reviewStatus) where.reviewStatus = query.reviewStatus;
    if (query.goodsCategory) where.goodsCategory = query.goodsCategory;
    if (query.invoiceNo) where.invoiceNo = { contains: query.invoiceNo };
    if (query.keyword) where.OR = [{ invoiceNo: { contains: query.keyword } }, { issuer: { contains: query.keyword } }];
    const [list, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { contract: { select: { id: true, code: true, name: true, supplierId: true, supplier: { select: { id: true, name: true } } } } },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id }, include: { contract: true } });
    if (!inv) throw new NotFoundException('发票不存在');
    return inv;
  }

  /** 发票号码查重（同一项目内唯一） */
  async checkNo(invoiceNo: string, projectId: string, excludeId?: string) {
    if (!invoiceNo) return { exists: false };
    const where: any = { projectId, invoiceNo };
    if (excludeId) where.id = { not: excludeId };
    const exist = await this.prisma.invoice.findFirst({ where });
    return { exists: !!exist };
  }

  private async validate(data: any) {
    await this.dict.validate('invoice_type', data.typeCode);
    await this.dict.validate('invoice_status', data.statusCode);
    await this.dict.validate('invoice_review_status', data.reviewStatus);
    await this.dict.validate('finance_transfer_status', data.financeTransferStatus);
    await this.dict.validate('goods_category', data.goodsCategory);
  }

  async create(data: any, projectId: string) {
    await this.validate(data);
    if (data.invoiceNo) {
      const { exists } = await this.checkNo(data.invoiceNo, projectId);
      if (exists) throw new BadRequestException(`发票号码 ${data.invoiceNo} 在当前项目中已存在`);
    }
    const payload: any = { ...pickFields(data, INVOICE_FIELDS, { label: '发票' }), projectId };
    ['amountBeforeTax', 'taxRate', 'amountWithTax'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (data.invoiceDate) payload.invoiceDate = toDate(data.invoiceDate);
    if (data.receiveDate) payload.receiveDate = toDate(data.receiveDate);
    // 开票单位可通过合同关联供应商库自动带出
    if (!payload.issuer && payload.contractId) {
      const c = await this.prisma.contract.findUnique({ where: { id: payload.contractId }, include: { supplier: true } });
      payload.issuer = (c as any)?.supplier?.name;
    }
    return this.prisma.invoice.create({ data: payload });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    await this.validate({ ...before, ...data });
    if (data.invoiceNo && data.invoiceNo !== before.invoiceNo) {
      const { exists } = await this.checkNo(data.invoiceNo, before.projectId, id);
      if (exists) throw new BadRequestException(`发票号码 ${data.invoiceNo} 在当前项目中已存在`);
    }
    const payload: any = pickFields(data, INVOICE_FIELDS, { label: '发票' });
    ['amountBeforeTax', 'taxRate', 'amountWithTax'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (data.invoiceDate) payload.invoiceDate = toDate(data.invoiceDate);
    if (data.receiveDate) payload.receiveDate = toDate(data.receiveDate);
    return this.prisma.invoice.update({ where: { id }, data: payload });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.invoice.delete({ where: { id } });
    return true;
  }

  /** 发票查验：预留第三方查验接口 */
  async verify(id: string) {
    const inv = await this.findOne(id);
    // TODO: 接入第三方查验（如航信/百望）后替换此处实现
    const result = { verified: true, provider: 'MOCK', message: '演示环境默认查验通过（第三方接口预留）' };
    return this.prisma.invoice.update({
      where: { id },
      data: { statusCode: inv.statusCode === 'WAIT_VERIFY' ? 'VERIFIED' : inv.statusCode },
    });
  }

  // ---------------- 开票申请 ----------------
  async findApplies(query: any = {}, projectId: string) {
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.statusCode) where.statusCode = query.statusCode;
    return this.prisma.invoiceApply.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { contract: { select: { id: true, code: true, name: true } } },
    });
  }

  async createApply(data: any, projectId: string, user: any) {
    await this.dict.validate('invoice_type', data.typeCode);
    await this.dict.validate('invoice_status', data.statusCode);
    const payload: any = pickFields(data, INVOICE_APPLY_FIELDS, { label: '开票申请' });
    return this.prisma.invoiceApply.create({
      data: { ...payload, projectId, amount: num(data.amount), taxRate: num(data.taxRate), createdBy: user?.userId },
    });
  }

  async removeApply(id: string) {
    await this.prisma.invoiceApply.delete({ where: { id } });
    return true;
  }

  // ---------------- Excel ----------------
  async export(projectId: string) {
    const res = await this.findAll({ pageSize: 2000 }, projectId);
    const [goods, review, finance, status] = await Promise.all([
      this.dict.nameMap('goods_category'), this.dict.nameMap('invoice_review_status'),
      this.dict.nameMap('finance_transfer_status'), this.dict.nameMap('invoice_status'),
    ]);
    const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const columns = [
      { header: '序号', key: 'index', width: 8 },
      { header: '商品类别', key: 'goodsCategoryName', width: 14 },
      { header: '结算账期', key: 'settlePeriod', width: 12 },
      { header: '开票单位', key: 'issuer', width: 28 },
      { header: '开票日期', key: 'invoiceDate', width: 14 },
      { header: '发票代码', key: 'invoiceCode', width: 16 },
      { header: '发票号码', key: 'invoiceNo', width: 16 },
      { header: '税前金额', key: 'amountBeforeTax', width: 16 },
      { header: '税率', key: 'taxRate', width: 10 },
      { header: '含税金额', key: 'amountWithTax', width: 16 },
      { header: '发票收取时间', key: 'receiveDate', width: 14 },
      { header: '发票信息审核', key: 'reviewStatusName', width: 14 },
      { header: '责任人', key: 'responsiblePerson', width: 12 },
      { header: '财务移交情况', key: 'financeTransferName', width: 14 },
      { header: '状态', key: 'statusName', width: 12 },
      { header: '备注', key: 'remark', width: 22 },
    ];
    const rows = (res.list as any[]).map((i, idx) => ({
      index: idx + 1,
      goodsCategoryName: goods[i.goodsCategory]?.name || '',
      settlePeriod: i.settlePeriod, issuer: i.issuer, invoiceDate: fmt(i.invoiceDate),
      invoiceCode: i.invoiceCode, invoiceNo: i.invoiceNo, amountBeforeTax: num(i.amountBeforeTax),
      taxRate: num(i.taxRate), amountWithTax: num(i.amountWithTax), receiveDate: fmt(i.receiveDate),
      reviewStatusName: review[i.reviewStatus]?.name || '', responsiblePerson: i.responsiblePerson,
      financeTransferName: finance[i.financeTransferStatus]?.name || '',
      statusName: status[i.statusCode]?.name || '', remark: i.remark,
    }));
    return this.excel.export(columns, rows, '发票台账');
  }

  async import(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer);
    const [goods, review, finance, status, types] = await Promise.all([
      this.dict.options('goods_category'), this.dict.options('invoice_review_status'),
      this.dict.options('finance_transfer_status'), this.dict.options('invoice_status'), this.dict.options('invoice_type'),
    ]);
    const codeOf = (items: any[], name: string) => items.find((i: any) => i.itemName === name || i.itemCode === name)?.itemCode || null;
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      try {
        const contractCode = String(r['合同编号'] ?? '').trim();
        const contract = contractCode ? await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } }) : null;
        await this.create(
          {
            contractId: contract?.id,
            goodsCategory: codeOf(goods, r['商品类别']),
            settlePeriod: r['结算账期'] || null,
            issuer: r['开票单位'] || null,
            invoiceDate: r['开票日期'] ? new Date(r['开票日期']) : null,
            invoiceCode: r['发票代码'] || null,
            invoiceNo: r['发票号码'] || null,
            amountBeforeTax: num(r['税前金额']),
            taxRate: num(r['税率']),
            amountWithTax: num(r['含税金额']),
            receiveDate: r['发票收取时间'] ? new Date(r['发票收取时间']) : null,
            reviewStatus: codeOf(review, r['发票信息审核']),
            responsiblePerson: r['责任人'] || null,
            financeTransferStatus: codeOf(finance, r['财务移交情况']),
            typeCode: codeOf(types, r['发票类型']),
            statusCode: codeOf(status, r['状态']),
            remark: r['备注'] || null,
          },
          projectId,
        );
        created++;
      } catch (e: any) {
        errors.push(`第 ${index + 2} 行：${e.message}`);
      }
    }
    return { created, errors };
  }
}
