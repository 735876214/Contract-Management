import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';

const DECIMAL_FIELDS = [
  'weighQty', 'deductQty', 'settleQty', 'priceBeforeTax', 'taxRate', 'priceAfterTax',
  'amountBeforeTax', 'amountAfterTax', 'incomePrice', 'incomeAmount', 'stdPrice', 'stdAmount',
];

@Injectable()
export class DailyReportService {
  constructor(private prisma: PrismaClient, private dict: DictService, private excel: ExcelService) {}

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.periodYear) where.periodYear = Number(query.periodYear);
    if (query.periodMonth) where.periodMonth = Number(query.periodMonth);
    if (query.contractId) where.contractId = query.contractId;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.materialCategory) where.materialCategory = query.materialCategory;
    if (query.materialType) where.materialType = query.materialType;
    if (query.assetStatus) where.assetStatus = query.assetStatus;
    if (query.sourceCode) where.sourceCode = query.sourceCode;
    if (query.keyword) where.OR = [{ materialName: { contains: query.keyword } }, { receiptNo: { contains: query.keyword } }, { plateNo: { contains: query.keyword } }];
    if (query.startDate || query.endDate) {
      where.entryDate = {};
      if (query.startDate) where.entryDate.gte = new Date(query.startDate);
      if (query.endDate) where.entryDate.lte = new Date(query.endDate);
    }
    const [list, total] = await Promise.all([
      this.prisma.dailyReport.findMany({
        where, skip, take,
        orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }, { createdAt: 'desc' }],
        include: {
          contract: { select: { id: true, code: true, name: true } },
          supplier: { select: { id: true, name: true } },
        },
      }),
      this.prisma.dailyReport.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const r = await this.prisma.dailyReport.findUnique({ where: { id }, include: { contract: true, supplier: true } });
    if (!r) throw new NotFoundException('日报不存在');
    return r;
  }

  /** 物资种类按材料类别联动 */
  async materialTypes(category?: string) {
    const items = await this.dict.options('material_type', category);
    return items.map((i: any) => ({ value: i.itemCode, label: i.itemName, extField1: i.extField1 }));
  }

  private async validate(data: any) {
    await this.dict.validate('yes_no', data.isAsset);
    await this.dict.validate('yes_no', data.isWeighed);
    await this.dict.validate('yes_no', data.isProxy);
    await this.dict.validate('asset_status', data.assetStatus);
    await this.dict.validate('material_source', data.sourceCode);
    await this.dict.validate('material_category', data.materialCategory);
    await this.dict.validate('material_type', data.materialType);
    await this.dict.validate('measurement_unit', data.unit);
  }

  private normalize(data: any) {
    const payload: any = { ...data };
    DECIMAL_FIELDS.forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    ['steelCount'].forEach((f) => {
      if (payload[f] !== undefined && payload[f] !== '') payload[f] = Number(payload[f]);
      else if (payload[f] === '') payload[f] = null;
    });
    if (data.entryDate) payload.entryDate = toDate(data.entryDate);
    return payload;
  }

  async create(data: any, projectId: string) {
    await this.validate(data);
    return this.prisma.dailyReport.create({ data: { ...this.normalize(data), projectId } });
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    await this.validate(data);
    return this.prisma.dailyReport.update({ where: { id }, data: this.normalize(data) });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.dailyReport.delete({ where: { id } });
    return true;
  }

  private exportColumns() {
    return [
      { header: '账期/年', key: 'periodYear', width: 10 },
      { header: '账期/月', key: 'periodMonth', width: 10 },
      { header: '进场日期', key: 'entryDate', width: 14 },
      { header: '合同编号', key: 'contractCode', width: 20 },
      { header: '是否资产', key: 'isAssetName', width: 10 },
      { header: '资产监管', key: 'assetSupervision', width: 14 },
      { header: '部门', key: 'department', width: 14 },
      { header: '人员', key: 'personnel', width: 12 },
      { header: '资产状态', key: 'assetStatusName', width: 12 },
      { header: '来源', key: 'sourceName', width: 18 },
      { header: '材料类别', key: 'materialCategoryName', width: 14 },
      { header: '物资种类', key: 'materialTypeName', width: 14 },
      { header: '物资名称', key: 'materialName', width: 20 },
      { header: '钢筋品牌', key: 'steelBrand', width: 12 },
      { header: '钢筋件数', key: 'steelCount', width: 12 },
      { header: '规格型号', key: 'spec', width: 14 },
      { header: '计量单位', key: 'unitName', width: 12 },
      { header: '过磅数量/t', key: 'weighQty', width: 14 },
      { header: '扣重/t', key: 'deductQty', width: 12 },
      { header: '结算数量', key: 'settleQty', width: 12 },
      { header: '是否过磅', key: 'isWeighedName', width: 12 },
      { header: '未云筑验收原因', key: 'noAcceptReason', width: 20 },
      { header: '单价/元(税前)', key: 'priceBeforeTax', width: 14 },
      { header: '税率', key: 'taxRate', width: 10 },
      { header: '单价/元(税后)', key: 'priceAfterTax', width: 14 },
      { header: '金额/元(税前)', key: 'amountBeforeTax', width: 16 },
      { header: '金额/元(税后)', key: 'amountAfterTax', width: 16 },
      { header: '供应单位', key: 'supplierName', width: 26 },
      { header: '领用单位', key: 'receiveUnit', width: 16 },
      { header: '领料人', key: 'receiver', width: 12 },
      { header: '劳务合同', key: 'laborContract', width: 16 },
      { header: '使用部位', key: 'usePosition', width: 16 },
      { header: '是否代购', key: 'isProxyName', width: 12 },
      { header: '车牌号', key: 'plateNo', width: 14 },
      { header: '收领单编号', key: 'receiptNo', width: 16 },
      { header: '备注', key: 'remark', width: 22 },
      { header: '分包计价账期', key: 'subcontractPeriod', width: 14 },
      { header: '收入单价', key: 'incomePrice', width: 12 },
      { header: '收入合价', key: 'incomeAmount', width: 14 },
      { header: '标准单价', key: 'stdPrice', width: 12 },
      { header: '标准合价', key: 'stdAmount', width: 14 },
    ];
  }

  async export(projectId: string) {
    const res = await this.findAll({ pageSize: 2000 }, projectId);
    const [yesNo, assetStatus, source, category, type, unit] = await Promise.all([
      this.dict.nameMap('yes_no'), this.dict.nameMap('asset_status'), this.dict.nameMap('material_source'),
      this.dict.nameMap('material_category'), this.dict.nameMap('material_type'), this.dict.nameMap('measurement_unit'),
    ]);
    const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const rows = (res.list as any[]).map((r) => ({
      periodYear: r.periodYear, periodMonth: r.periodMonth, entryDate: fmt(r.entryDate),
      contractCode: r.contract?.code, isAssetName: yesNo[r.isAsset]?.name || '', assetSupervision: r.assetSupervision,
      department: r.department, personnel: r.personnel,
      assetStatusName: assetStatus[r.assetStatus]?.name || '', sourceName: source[r.sourceCode]?.name || '',
      materialCategoryName: category[r.materialCategory]?.name || '', materialTypeName: type[r.materialType]?.name || '',
      materialName: r.materialName, steelBrand: r.steelBrand, steelCount: r.steelCount, spec: r.spec,
      unitName: unit[r.unit]?.name || '', weighQty: num(r.weighQty), deductQty: num(r.deductQty), settleQty: num(r.settleQty),
      isWeighedName: yesNo[r.isWeighed]?.name || '', noAcceptReason: r.noAcceptReason,
      priceBeforeTax: num(r.priceBeforeTax), taxRate: num(r.taxRate), priceAfterTax: num(r.priceAfterTax),
      amountBeforeTax: num(r.amountBeforeTax), amountAfterTax: num(r.amountAfterTax),
      supplierName: r.supplier?.name, receiveUnit: r.receiveUnit, receiver: r.receiver,
      laborContract: r.laborContract, usePosition: r.usePosition, isProxyName: yesNo[r.isProxy]?.name || '',
      plateNo: r.plateNo, receiptNo: r.receiptNo, remark: r.remark, subcontractPeriod: r.subcontractPeriod,
      incomePrice: num(r.incomePrice), incomeAmount: num(r.incomeAmount), stdPrice: num(r.stdPrice), stdAmount: num(r.stdAmount),
    }));
    return this.excel.export(this.exportColumns(), rows, '日报');
  }

  async import(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer);
    const [yesNo, assetStatus, source, category, type, unit] = await Promise.all([
      this.dict.options('yes_no'), this.dict.options('asset_status'), this.dict.options('material_source'),
      this.dict.options('material_category'), this.dict.options('material_type'), this.dict.options('measurement_unit'),
    ]);
    const codeOf = (items: any[], name: string) => {
      const hit = items.find((i: any) => i.itemName === name || i.itemCode === name);
      return hit?.itemCode || null;
    };
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      try {
        const contractCode = String(r['合同编号'] ?? '').trim();
        const supplierName = String(r['供应单位'] ?? '').trim();
        const contract = contractCode ? await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } }) : null;
        const supplier = supplierName ? await this.prisma.supplier.findFirst({ where: { name: supplierName } }) : null;
        await this.create(
          {
            periodYear: Number(r['账期/年']) || null,
            periodMonth: Number(r['账期/月']) || null,
            entryDate: r['进场日期'] ? new Date(r['进场日期']) : null,
            contractId: contract?.id,
            isAsset: codeOf(yesNo, r['是否资产']),
            assetSupervision: r['资产监管'] || null,
            department: r['部门'] || null,
            personnel: r['人员'] || null,
            assetStatus: codeOf(assetStatus, r['资产状态']),
            sourceCode: codeOf(source, r['来源']),
            materialCategory: codeOf(category, r['材料类别']),
            materialType: codeOf(type, r['物资种类']),
            materialName: r['物资名称'] || null,
            steelBrand: r['钢筋品牌'] || null,
            steelCount: Number(r['钢筋件数']) || null,
            spec: r['规格型号'] || null,
            unit: codeOf(unit, r['计量单位']),
            weighQty: num(r['过磅数量/t']),
            deductQty: num(r['扣重/t']),
            settleQty: num(r['结算数量']),
            isWeighed: codeOf(yesNo, r['是否过磅']),
            noAcceptReason: r['未云筑验收原因'] || null,
            priceBeforeTax: num(r['单价/元(税前)']),
            taxRate: num(r['税率']),
            priceAfterTax: num(r['单价/元(税后)']),
            amountBeforeTax: num(r['金额/元(税前)']),
            amountAfterTax: num(r['金额/元(税后)']),
            supplierId: supplier?.id,
            receiveUnit: r['领用单位'] || null,
            receiver: r['领料人'] || null,
            laborContract: r['劳务合同'] || null,
            usePosition: r['使用部位'] || null,
            isProxy: codeOf(yesNo, r['是否代购']),
            plateNo: r['车牌号'] || null,
            receiptNo: r['收领单编号'] || null,
            remark: r['备注'] || null,
            subcontractPeriod: r['分包计价账期'] || null,
            incomePrice: num(r['收入单价']),
            incomeAmount: num(r['收入合价']),
            stdPrice: num(r['标准单价']),
            stdAmount: num(r['标准合价']),
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
