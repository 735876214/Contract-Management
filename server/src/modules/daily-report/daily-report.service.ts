import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion, IMPORT_MAX_ROWS } from '../../common/utils/helpers';
import { round4 } from '../../common/utils/money';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';

const DECIMAL_FIELDS = [
  'weighQty', 'deductQty', 'settleQty', 'priceBeforeTax', 'taxRate', 'priceAfterTax',
  'amountBeforeTax', 'amountAfterTax', 'incomePrice', 'incomeAmount', 'stdPrice', 'stdAmount',
];

@Injectable()
export class DailyReportService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private styled: StyledExcelService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
  ) {}

  async findAll(query: any = {}, projectId: string, maxPageSize = 500) {
    const { skip, take } = paginate(query, maxPageSize);
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

  /**
   * 按合同聚合日报「结算数量」合计（按物资主数据分组）。
   * 用途：补充协议「原合同剩余数量 = 原合同数量 − 日报已发生数量」。
   */
  async contractSettledQty(contractId: string, projectId: string) {
    if (!contractId) return [];
    const rows = await this.prisma.dailyReport.groupBy({
      by: ['materialBaseId'],
      where: { projectId, contractId, materialBaseId: { not: null } },
      _sum: { settleQty: true },
    });
    return rows.map((r) => ({
      materialBaseId: r.materialBaseId as string,
      settleQty: num(r._sum?.settleQty),
    }));
  }

  private async validate(data: any) {
    await this.dict.validate('yes_no', data.isAsset);
    await this.dict.validate('yes_no', data.isSafetyMaterial);
    await this.dict.validate('yes_no', data.isWeighed);
    await this.dict.validate('yes_no', data.isProxy);
    await this.dict.validate('asset_status', data.assetStatus);
    await this.dict.validate('material_source', data.sourceCode);
    await this.dict.validate('material_category', data.materialCategory);
    await this.dict.validate('material_type', data.materialType);
    // 需求 2.3.2：计量单位默认取物资基础库，允许手输但必须存在于字典「measurement_unit」
    // 接受字典编码或名称，统一归一为字典编码落库
    const unitRaw = String(data.unit ?? '').trim();
    if (unitRaw) {
      const unitItems = await this.dict.options('measurement_unit');
      const hit = unitItems.find((u: any) => u.itemCode === unitRaw || u.itemName === unitRaw);
      if (!hit) throw new BadRequestException('计量单位不在字典范围内，请先在字典管理中添加');
      data.unit = hit.itemCode;
    }
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

  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    // 事务内不得调用 this.dict（它使用事务外的 PrismaClient 连接，连接池耗尽会挂起）。
    // 导入流程已在事务外的 map 阶段完成 validate，此处仅在无事务的直连写入时校验。
    if (!tx) await this.validate(data);
    return db.dailyReport.create({ data: { ...this.normalize(data), projectId } });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    await this.validate(data);
    const payload: any = this.normalize(data);
    delete payload.version;
    return this.prisma.dailyReport.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
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
      { header: '是否安全物资', key: 'isSafetyMaterialName', width: 14 },
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
    const res = await this.findAll({ pageSize: 2000 }, projectId, IMPORT_MAX_ROWS);
    const [yesNo, assetStatus, source, category, type, unit] = await Promise.all([
      this.dict.nameMap('yes_no'), this.dict.nameMap('asset_status'), this.dict.nameMap('material_source'),
      this.dict.nameMap('material_category'), this.dict.nameMap('material_type'), this.dict.nameMap('measurement_unit'),
    ]);
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const rows = (res.list as any[]).map((r) => {
      const priceAfterTax = num(r.priceAfterTax);
      const stdPrice = num(r.stdPrice);
      const reduceAmount = stdPrice !== null && priceAfterTax !== null ? Math.round((stdPrice - priceAfterTax) * 100) / 100 : null;
      const reduceRatio = stdPrice && reduceAmount !== null ? Math.round((reduceAmount / stdPrice) * 10000) / 10000 : null;
      return {
        periodYear: r.periodYear ? String(r.periodYear) : '',
        periodMonth: r.periodMonth ? `${r.periodYear}年${r.periodMonth}月` : '',
        entryDate: fmt(r.entryDate),
        isAssetName: yesNo[r.isAsset]?.name || '',
        isSafetyMaterialName: yesNo[r.isSafetyMaterial]?.name || '',
        assetSupervision: [r.department, r.personnel].filter(Boolean).join('，'),
        assetStatusName: assetStatus[r.assetStatus]?.name || '',
        sourceName: source[r.sourceCode]?.name || '',
        materialCategoryName: category[r.materialCategory]?.name || '',
        materialTypeName: type[r.materialType]?.name || '',
        materialName: r.materialName,
        brandCount: [r.steelBrand, r.steelCount ? `${r.steelCount}件` : ''].filter(Boolean).join(' '),
        spec: r.spec,
        unitName: unit[r.unit]?.name || '',
        weighQty: num(r.weighQty), deductQty: num(r.deductQty), settleQty: num(r.settleQty),
        isWeighedName: yesNo[r.isWeighed]?.name || '',
        noAcceptReason: r.noAcceptReason,
        priceBeforeTax: round4(r.priceBeforeTax), taxRate: num(r.taxRate), priceAfterTax,
        amountBeforeTax: num(r.amountBeforeTax), amountAfterTax: num(r.amountAfterTax),
        stdPrice,
        reduceAmount, reduceRatio,
        supplierName: r.supplier?.name, receiveUnit: r.receiveUnit, receiver: r.receiver,
        laborContract: r.laborContract, usePosition: r.usePosition, isProxyName: yesNo[r.isProxy]?.name || '',
      };
    });
    const [srcOpts, catOpts, typeOpts, yesOpts, assetOpts] = await Promise.all([
      this.dict.options('material_source'), this.dict.options('material_category'), this.dict.options('material_type'),
      this.dict.options('yes_no'), this.dict.options('asset_status'),
    ]);
    const names = (list: any[]) => list.map((i: any) => i.itemName).filter(Boolean);
    const buffer = await this.styled.exportTable({
      sheetName: '物资进出场台账',
      title: `物资进出台账台账（${project?.name || ''}）`,
      logoColumn: true,
      columns: [
        { header: '账期/年', key: 'periodYear', width: 80, type: 'center' },
        { header: '账期/月', key: 'periodMonth', width: 100, type: 'center' },
        { header: '进场日期', key: 'entryDate', width: 110, type: 'center' },
        { header: '是否资产', key: 'isAssetName', width: 80, type: 'center' },
        { header: '是否安全物资', key: 'isSafetyMaterialName', width: 100, type: 'center' },
        { header: '资产监管部门，人员', key: 'assetSupervision', width: 130, type: 'center' },
        { header: '资产状态', key: 'assetStatusName', width: 80, type: 'center' },
        { header: '来源', key: 'sourceName', width: 120, type: 'center' },
        { header: '材料类别', key: 'materialCategoryName', width: 100, type: 'center' },
        { header: '物资种类', key: 'materialTypeName', width: 100, type: 'center' },
        { header: '物资名称', key: 'materialName', width: 120 },
        { header: '品牌+件数', key: 'brandCount', width: 100, type: 'center' },
        { header: '规格型号', key: 'spec', width: 200 },
        { header: '计量单位', key: 'unitName', width: 70, type: 'center' },
        { header: '过磅数量/t', key: 'weighQty', width: 110, type: 'qty' },
        { header: '扣重/t', key: 'deductQty', width: 90, type: 'qty' },
        { header: '结算数量', key: 'settleQty', width: 110, type: 'qty' },
        { header: '是否过磅', key: 'isWeighedName', width: 80, type: 'center' },
        { header: '未云筑验收原因', key: 'noAcceptReason', width: 130 },
        { header: '单价/元（税前）', key: 'priceBeforeTax', width: 120, type: 'qty' },
        { header: '税率', key: 'taxRate', width: 70, type: 'pct' },
        { header: '单价/元（税后）', key: 'priceAfterTax', width: 120, type: 'qty' },
        { header: '金额/元（税前）', key: 'amountBeforeTax', width: 130, type: 'money' },
        { header: '金额/元（税后）', key: 'amountAfterTax', width: 130, type: 'money' },
        { header: '标准成本单价', key: 'stdPrice', width: 120, type: 'qty' },
        { header: '成本降低额', key: 'reduceAmount', width: 120, type: 'money' },
        { header: '成本降低率', key: 'reduceRatio', width: 110, type: 'pct' },
        { header: '供应单位', key: 'supplierName', width: 150 },
        { header: '领用单位', key: 'receiveUnit', width: 150 },
        { header: '领料人', key: 'receiver', width: 80, type: 'center' },
        { header: '劳务合同', key: 'laborContract', width: 100, type: 'center' },
        { header: '使用部位', key: 'usePosition', width: 150 },
        { header: '是否代购', key: 'isProxyName', width: 80, type: 'center' },
      ],
      rows,
      totalsKeys: ['settleQty', 'amountBeforeTax', 'amountAfterTax'],
      totalsLabel: '汇总',
      dropdowns: {
        sourceName: names(srcOpts),
        materialCategoryName: names(catOpts),
        materialTypeName: names(typeOpts),
        isAssetName: names(yesOpts),
        isSafetyMaterialName: names(yesOpts),
        assetStatusName: names(assetOpts),
        isWeighedName: names(yesOpts),
        isProxyName: names(yesOpts),
      },
    });
    return buffer;
  }

  /** 物资日报导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async import(buffer: Buffer, projectId: string, meta?: { fileName?: string; user?: any }) {
    const rows = await this.excel.parse(buffer);
    const [yesNo, assetStatus, source, category, type, unit] = await Promise.all([
      this.dict.options('yes_no'), this.dict.options('asset_status'), this.dict.options('material_source'),
      this.dict.options('material_category'), this.dict.options('material_type'), this.dict.options('measurement_unit'),
    ]);
    const codeOf = (items: any[], name: string) => {
      const hit = items.find((i: any) => i.itemName === name || i.itemCode === name);
      return hit?.itemCode || null;
    };
    return this.tasks.submit<any>({ module: 'daily-report', moduleName: '物资日报', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      startRowNo: 2,
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        const supplierName = String(r['供应单位'] ?? '').trim();
        const contract = contractCode
          ? await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } })
          : null;
        if (contractCode && !contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const supplier = supplierName
          ? await this.prisma.supplier.findFirst({ where: { name: supplierName } })
          : null;
        if (supplierName && !supplier) throw new RowError(`关联校验失败：供应商库中不存在「${supplierName}」`, '供应单位');
        // 物资名称/规格型号统一取自物资基础库，日报通过 materialBaseId 关联（需求 2.5）
        const materialName = String(r['物资名称'] ?? '').trim() || null;
        const spec = String(r['规格型号'] ?? '').trim() || null;
        let materialBaseId: string | null = null;
        if (materialName && spec) {
          const base = await this.prisma.materialBase.findFirst({ where: { name: materialName, spec } });
          if (!base) throw new RowError(`关联校验失败：物资基础库中不存在「${materialName} / ${spec}」，请先维护物资基础库`, '物资名称');
          materialBaseId = base.id;
        }
        const data: any = {
          periodYear: Number(r['账期/年']) || null,
          periodMonth: Number(r['账期/月']) || null,
          entryDate: r['进场日期'] ? new Date(r['进场日期']) : null,
          contractId: contract?.id,
          isAsset: codeOf(yesNo, r['是否资产']),
          isSafetyMaterial: codeOf(yesNo, r['是否安全物资']),
          assetSupervision: r['资产监管'] || null,
          department: r['部门'] || null,
          personnel: r['人员'] || null,
          assetStatus: codeOf(assetStatus, r['资产状态']),
          sourceCode: codeOf(source, r['来源']),
          materialCategory: codeOf(category, r['材料类别']),
          materialType: codeOf(type, r['物资种类']),
          materialBaseId,
          materialName,
          steelBrand: r['钢筋品牌'] || null,
          steelCount: Number(r['钢筋件数']) || null,
          spec,
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
        };
        await this.validate(data);
        return { data };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.create(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }
}
