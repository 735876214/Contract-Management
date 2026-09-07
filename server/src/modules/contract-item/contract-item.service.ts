import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';

@Injectable()
export class ContractItemService {
  constructor(private prisma: PrismaClient, private dict: DictService, private excel: ExcelService) {}

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.materialCategory) where.materialCategory = query.materialCategory;
    if (query.keyword) where.OR = [{ materialName: { contains: query.keyword } }, { spec: { contains: query.keyword } }];
    const [list, total] = await Promise.all([
      this.prisma.contractItem.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: {
          contract: { select: { id: true, code: true, name: true } },
          supplier: { select: { id: true, name: true } },
        },
      }),
      this.prisma.contractItem.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const item = await this.prisma.contractItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('合同清单不存在');
    return item;
  }

  private async validate(data: any) {
    await this.dict.validate('material_category', data.materialCategory);
    await this.dict.validate('measurement_unit', data.unit);
  }

  async create(data: any, projectId: string) {
    await this.validate(data);
    const payload: any = { ...data, projectId };
    ['qty', 'costPrice', 'taxRate', 'comprehensivePrice'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (!payload.supplierId && payload.contractId) {
      const c = await this.prisma.contract.findUnique({ where: { id: payload.contractId } });
      payload.supplierId = c?.supplierId;
    }
    return this.prisma.contractItem.create({ data: payload });
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    await this.validate(data);
    const payload: any = { ...data };
    ['qty', 'costPrice', 'taxRate', 'comprehensivePrice'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    return this.prisma.contractItem.update({ where: { id }, data: payload });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.contractItem.delete({ where: { id } });
    return true;
  }

  /** 由合同关联的日报明细汇总生成清单（按物资+规格聚合） */
  async generateFromContract(contractId: string, projectId: string) {
    const contract = await this.prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) throw new NotFoundException('合同不存在');
    if (contract.projectId !== projectId) throw new BadRequestException('合同不属于当前项目');
    const reports = await this.prisma.dailyReport.findMany({ where: { contractId } });
    if (!reports.length) throw new BadRequestException('该合同下暂无日报数据，无法生成清单');
    const grouped: Record<string, any> = {};
    reports.forEach((r: any) => {
      const key = `${r.materialName || ''}|${r.spec || ''}|${r.unit || ''}|${r.materialCategory || ''}`;
      if (!grouped[key]) {
        grouped[key] = {
          projectId,
          contractId,
          supplierId: r.supplierId,
          materialCategory: r.materialCategory,
          materialName: r.materialName,
          spec: r.spec,
          unit: r.unit,
          qty: 0,
          costPrice: num(r.priceBeforeTax),
          taxRate: num(r.taxRate),
          comprehensivePrice: num(r.priceAfterTax),
        };
      }
      grouped[key].qty += num(r.settleQty) || 0;
    });
    const data = Object.values(grouped);
    await this.prisma.contractItem.createMany({ data });
    return { created: data.length };
  }

  async export(projectId: string) {
    const res = await this.findAll({ pageSize: 2000 }, projectId);
    const [category, unit] = await Promise.all([this.dict.nameMap('material_category'), this.dict.nameMap('measurement_unit')]);
    const columns = [
      { header: '供应商名称', key: 'supplierName', width: 28 },
      { header: '供应物资类别', key: 'materialCategoryName', width: 14 },
      { header: '合同编号', key: 'contractCode', width: 20 },
      { header: '材料名称', key: 'materialName', width: 22 },
      { header: '规格型号', key: 'spec', width: 14 },
      { header: '计量单位', key: 'unitName', width: 12 },
      { header: '数量', key: 'qty', width: 12 },
      { header: '成本单价', key: 'costPrice', width: 14 },
      { header: '税率', key: 'taxRate', width: 10 },
      { header: '综合单价', key: 'comprehensivePrice', width: 14 },
      { header: '备注', key: 'remark', width: 22 },
    ];
    const rows = (res.list as any[]).map((i) => ({
      supplierName: i.supplier?.name, materialCategoryName: category[i.materialCategory]?.name || '',
      contractCode: i.contract?.code, materialName: i.materialName, spec: i.spec,
      unitName: unit[i.unit]?.name || '', qty: num(i.qty), costPrice: num(i.costPrice),
      taxRate: num(i.taxRate), comprehensivePrice: num(i.comprehensivePrice), remark: i.remark,
    }));
    return this.excel.export(columns, rows, '合同清单');
  }

  async import(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer);
    const [category, unit] = await Promise.all([this.dict.options('material_category'), this.dict.options('measurement_unit')]);
    const codeOf = (items: any[], name: string) => items.find((i: any) => i.itemName === name || i.itemCode === name)?.itemCode || null;
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      try {
        const contractCode = String(r['合同编号'] ?? '').trim();
        const supplierName = String(r['供应商名称'] ?? '').trim();
        const contract = contractCode ? await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } }) : null;
        const supplier = supplierName ? await this.prisma.supplier.findFirst({ where: { name: supplierName } }) : null;
        await this.create(
          {
            contractId: contract?.id, supplierId: supplier?.id,
            materialCategory: codeOf(category, r['供应物资类别']),
            materialName: r['材料名称'] || null,
            spec: r['规格型号'] || null,
            unit: codeOf(unit, r['计量单位']),
            qty: num(r['数量']), costPrice: num(r['成本单价']), taxRate: num(r['税率']),
            comprehensivePrice: num(r['综合单价']), remark: r['备注'] || null,
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
