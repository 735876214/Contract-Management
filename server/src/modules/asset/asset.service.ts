import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { DictService } from '../dict/dict.service';

const ASSET_FIELDS = [
  'date', 'sourceCode', 'categoryL1Code', 'categoryFocusCode', 'name', 'spec', 'unit',
  'qty', 'price', 'supplierId', 'receiveUnit', 'responsible',
  'inUseQty', 'idleQty', 'scrapQty', 'lostQty',
  'remark', 'turnoverCount', 'originalPrice', 'transferOutPrice',
];

const round2 = (n: any) => (n === null || n === undefined ? null : Math.round((Number(n) + Number.EPSILON) * 100) / 100);
const mul = (a: any, b: any) => (num(a) !== null && num(b) !== null ? round2(Number(a) * Number(b)) : null);

@Injectable()
export class AssetService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private styled: StyledExcelService,
  ) {}

  /** 计算派生金额字段（需求 2.6：数量 × 单价 自动） */
  private derived(data: Record<string, any>) {
    const price = num(data.price);
    return {
      totalAmount: mul(data.qty, price),
      inUseAmount: mul(data.inUseQty, price),
      idleAmount: mul(data.idleQty, price),
      scrapAmount: mul(data.scrapQty, price),
      lostAmount: mul(data.lostQty, price),
      originalTotal: mul(data.qty, data.originalPrice),
      transferOutAmount: mul(data.qty, data.transferOutPrice),
    };
  }

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.keyword) {
      where.OR = [{ name: { contains: query.keyword } }, { spec: { contains: query.keyword } }, { receiveUnit: { contains: query.keyword } }];
    }
    if (query.sourceCode) where.sourceCode = query.sourceCode;
    if (query.categoryL1Code) where.categoryL1Code = query.categoryL1Code;
    if (query.categoryFocusCode) where.categoryFocusCode = query.categoryFocusCode;
    const [list, total] = await Promise.all([
      this.prisma.assetLedger.findMany({
        where, skip, take,
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        include: { supplier: { select: { name: true } } },
      }),
      this.prisma.assetLedger.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  private validate(data: any) {
    // 调入费/维保费行只填金额，不填数量（数量可空）
    if (['TRANSFER_IN_FEE', 'MAINTENANCE'].includes(data.sourceCode)) return;
    if (data.qty !== undefined && data.qty !== null && Number(data.qty) < 0) throw new BadRequestException('进/出场数量不能为负数');
    const statusSum = (num(data.inUseQty) || 0) + (num(data.idleQty) || 0) + (num(data.scrapQty) || 0) + (num(data.lostQty) || 0);
    const qty = num(data.qty) || 0;
    if (statusSum > 0 && qty > 0 && Math.abs(statusSum - qty) > 0.0001) {
      throw new BadRequestException(`在用/闲置/报废/丢失数量合计（${statusSum}）应等于进/出场数量（${qty}）`);
    }
  }

  async create(data: any, projectId: string) {
    this.validate(data);
    const payload = pickFields(data, ASSET_FIELDS.filter((f) => f !== 'date'), { label: '资产台账' });
    payload.projectId = projectId;
    payload.date = data.date ? new Date(data.date) : null;
    for (const k of ['qty', 'price', 'inUseQty', 'idleQty', 'scrapQty', 'lostQty', 'originalPrice', 'transferOutPrice']) {
      if (payload[k] !== undefined) payload[k] = payload[k] === null || payload[k] === '' ? null : Number(payload[k]);
    }
    if (payload.turnoverCount !== undefined) payload.turnoverCount = payload.turnoverCount === null || payload.turnoverCount === '' ? null : Number(payload.turnoverCount);
    Object.assign(payload, this.derived({ ...payload }));
    return this.prisma.assetLedger.create({ data: payload });
  }

  async update(id: string, data: any) {
    const old = await this.prisma.assetLedger.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('资产台账记录不存在');
    this.validate({ ...old, ...data });
    const payload = pickFields(data, ASSET_FIELDS.filter((f) => f !== 'date'), { label: '资产台账' });
    if (data.date !== undefined) payload.date = data.date ? new Date(data.date) : null;
    for (const k of ['qty', 'price', 'inUseQty', 'idleQty', 'scrapQty', 'lostQty', 'originalPrice', 'transferOutPrice']) {
      if (payload[k] !== undefined) payload[k] = payload[k] === null || payload[k] === '' ? null : Number(payload[k]);
    }
    if (payload.turnoverCount !== undefined) payload.turnoverCount = payload.turnoverCount === null || payload.turnoverCount === '' ? null : Number(payload.turnoverCount);
    const merged = { ...old, ...payload } as any;
    Object.assign(payload, this.derived(merged));
    return this.prisma.assetLedger.update({ where: { id }, data: payload });
  }

  async remove(id: string) {
    const old = await this.prisma.assetLedger.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('资产台账记录不存在');
    await this.prisma.assetLedger.delete({ where: { id } });
    return true;
  }

  async export(projectId: string) {
    const res = await this.findAll({ pageSize: 5000 }, projectId);
    const [source, catL1, catFocus, unit] = await Promise.all([
      this.dict.nameMap('asset_ledger_source'), this.dict.nameMap('asset_category_l1'),
      this.dict.nameMap('asset_category_focus'), this.dict.nameMap('measurement_unit'),
    ]);
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const rows = (res.list as any[]).map((r) => ({
      date: fmt(r.date),
      sourceName: source[r.sourceCode]?.name || '',
      categoryL1Name: catL1[r.categoryL1Code]?.name || '',
      categoryFocusName: catFocus[r.categoryFocusCode]?.name || '',
      name: r.name, spec: r.spec,
      unitName: unit[r.unit]?.name || '',
      qty: num(r.qty), price: num(r.price), totalAmount: num(r.totalAmount),
      supplierName: r.supplier?.name, receiveUnit: r.receiveUnit, responsible: r.responsible,
      inUseQty: num(r.inUseQty), inUseAmount: num(r.inUseAmount),
      idleQty: num(r.idleQty), idleAmount: num(r.idleAmount),
      scrapQty: num(r.scrapQty), scrapAmount: num(r.scrapAmount),
      lostQty: num(r.lostQty), lostAmount: num(r.lostAmount),
      remark: r.remark, turnoverCount: r.turnoverCount,
      originalPrice: num(r.originalPrice), originalTotal: num(r.originalTotal),
      transferOutPrice: num(r.transferOutPrice), transferOutAmount: num(r.transferOutAmount),
    }));
    const buffer = await this.styled.exportTable({
      sheetName: '资产管理台账',
      title: `资 产 管 理 台 账（${project?.name || ''}）`,
      columns: [
        { header: '日期', key: 'date', width: 100, type: 'center' },
        { header: '来源', key: 'sourceName', width: 100, type: 'center' },
        { header: '资产类别（一级）', key: 'categoryL1Name', width: 130, type: 'center' },
        { header: '资产类别（重点关注）', key: 'categoryFocusName', width: 150, type: 'center' },
        { header: '资产名称', key: 'name', width: 130 },
        { header: '规格型号', key: 'spec', width: 140 },
        { header: '单位', key: 'unitName', width: 60, type: 'center' },
        { header: '进/出场数量', key: 'qty', width: 110, type: 'qty' },
        { header: '进/出场单价', key: 'price', width: 110, type: 'money' },
        { header: '进/出场总额（资产现值）', key: 'totalAmount', width: 170, type: 'money' },
        { header: '供应单位', key: 'supplierName', width: 160 },
        { header: '领用单位/部门', key: 'receiveUnit', width: 130 },
        { header: '责任人', key: 'responsible', width: 80, type: 'center' },
        { header: '在用', key: 'inUseQty', width: 80, type: 'qty' },
        { header: '在用金额', key: 'inUseAmount', width: 110, type: 'money' },
        { header: '闲置', key: 'idleQty', width: 80, type: 'qty' },
        { header: '闲置金额', key: 'idleAmount', width: 110, type: 'money' },
        { header: '报废', key: 'scrapQty', width: 80, type: 'qty' },
        { header: '报废金额', key: 'scrapAmount', width: 110, type: 'money' },
        { header: '丢失', key: 'lostQty', width: 80, type: 'qty' },
        { header: '丢失金额', key: 'lostAmount', width: 110, type: 'money' },
        { header: '备注', key: 'remark', width: 140 },
        { header: '周转次数（含本次）', key: 'turnoverCount', width: 130, type: 'int' },
        { header: '原值单价', key: 'originalPrice', width: 100, type: 'money' },
        { header: '原值总额', key: 'originalTotal', width: 110, type: 'money' },
        { header: '调出物资本项目进场时单价', key: 'transferOutPrice', width: 180, type: 'money' },
        { header: '调出物资本项目进场时金额', key: 'transferOutAmount', width: 180, type: 'money' },
      ],
      rows,
      totalsKeys: ['qty', 'totalAmount', 'inUseAmount', 'idleAmount', 'scrapAmount', 'lostAmount', 'originalTotal', 'transferOutAmount'],
      totalsLabel: '汇总',
      dropdowns: {
        sourceName: (await this.dict.options('asset_ledger_source')).map((i: any) => i.itemName),
        categoryL1Name: (await this.dict.options('asset_category_l1')).map((i: any) => i.itemName),
        categoryFocusName: (await this.dict.options('asset_category_focus')).map((i: any) => i.itemName),
      },
    });
    return { buffer, filename: `资产管理台账-${project?.name || ''}.xlsx` };
  }
}
