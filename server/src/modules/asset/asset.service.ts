import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
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
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
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

  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    this.validate(data);
    const payload = pickFields(data, ASSET_FIELDS.filter((f) => f !== 'date'), { label: '资产台账' });
    payload.projectId = projectId;
    payload.date = data.date ? new Date(data.date) : null;
    for (const k of ['qty', 'price', 'inUseQty', 'idleQty', 'scrapQty', 'lostQty', 'originalPrice', 'transferOutPrice']) {
      if (payload[k] !== undefined) payload[k] = payload[k] === null || payload[k] === '' ? null : Number(payload[k]);
    }
    if (payload.turnoverCount !== undefined) payload.turnoverCount = payload.turnoverCount === null || payload.turnoverCount === '' ? null : Number(payload.turnoverCount);
    Object.assign(payload, this.derived({ ...payload }));
    return db.assetLedger.create({ data: payload });
  }

  async update(id: string, data: any) {
    const old = await this.prisma.assetLedger.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('资产台账记录不存在');
    assertVersion(old, data);
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

  /** 资产管理台账填写模板（需求 3.3，实际字段口径） */
  async template() {
    const [source, catL1, catFocus, unit] = await Promise.all([
      this.dict.options('asset_ledger_source'), this.dict.options('asset_category_l1'),
      this.dict.options('asset_category_focus'), this.dict.options('measurement_unit'),
    ]);
    const names = (list: any[]) => list.map((i: any) => i.itemName).filter(Boolean);
    const columns: TemplateColumn[] = [
      { label: '日期', key: 'date', required: true, type: 'date', width: 14, example: '2026-09-01' },
      { label: '来源', key: 'sourceName', required: true, type: 'select', width: 14, example: '采购', options: names(source) },
      { label: '资产类别（一级）', key: 'categoryL1Name', required: true, type: 'select', width: 18, example: '大型设备', options: names(catL1) },
      { label: '资产类别（重点关注）', key: 'categoryFocusName', type: 'select', width: 20, example: '', options: names(catFocus) },
      { label: '资产名称', key: 'name', required: true, type: 'text', width: 20, example: '塔式起重机' },
      { label: '规格型号', key: 'spec', type: 'text', width: 18, example: 'QTZ80' },
      { label: '单位', key: 'unitName', type: 'select', width: 10, example: '台', options: names(unit) },
      { label: '进/出场数量', key: 'qty', type: 'qty', width: 14, example: 2, desc: '「调入费/维保费」行无需填写' },
      { label: '进/出场单价（金额）', key: 'price', required: true, type: 'money', width: 20, example: 5000.5 },
      { label: '领用单位/部门', key: 'receiveUnit', type: 'text', width: 18, example: '一标段' },
      { label: '责任人', key: 'responsible', type: 'text', width: 12, example: '王强' },
      { label: '在用数量', key: 'inUseQty', type: 'qty', width: 12, example: 1, desc: '在用/闲置/报废/丢失数量合计应等于进/出场数量' },
      { label: '闲置数量', key: 'idleQty', type: 'qty', width: 12, example: 1 },
      { label: '报废数量', key: 'scrapQty', type: 'qty', width: 12, example: 0 },
      { label: '丢失数量', key: 'lostQty', type: 'qty', width: 12, example: 0 },
      { label: '周转次数（含本次）', key: 'turnoverCount', type: 'int', width: 16, example: 1 },
      { label: '原值单价', key: 'originalPrice', type: 'money', width: 12, example: 6000 },
      { label: '调出物资本项目进场时单价', key: 'transferOutPrice', type: 'money', width: 24, example: 0 },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({
      moduleName: '资产管理台账',
      sheetName: '数据',
      columns,
      extraNotes: ['提示：进/出场总额、在用/闲置/报废/丢失金额、原值总额、调出进场金额均由系统按「数量 × 单价」自动计算，无需填写。'],
    });
  }

  /** 资产管理台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importAssets(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const [source, catL1, catFocus, unit] = await Promise.all([
      this.dict.options('asset_ledger_source'), this.dict.options('asset_category_l1'),
      this.dict.options('asset_category_focus'), this.dict.options('measurement_unit'),
    ]);
    const codeOf = (items: any[], val: any) =>
      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    return this.runner.run<any>(rows, {
      plan: async (r) => {
        const name = String(r['资产名称'] ?? '').trim();
        if (!name) throw new RowError('资产名称为必填项', '资产名称');
        const sourceVal = String(r['来源'] ?? '').trim();
        if (!sourceVal) throw new RowError('来源为必填项', '来源');
        const sourceCode = codeOf(source, sourceVal);
        if (!sourceCode) throw new RowError(`下拉校验失败：「${sourceVal}」不在资产来源选项范围内`, '来源');
        const catL1Val = String(r['资产类别（一级）'] ?? '').trim();
        if (!catL1Val) throw new RowError('资产类别（一级）为必填项', '资产类别（一级）');
        const categoryL1Code = codeOf(catL1, catL1Val);
        if (!categoryL1Code) throw new RowError(`下拉校验失败：「${catL1Val}」不在资产类别选项范围内`, '资产类别（一级）');
        const price = num(r['进/出场单价（金额）']);
        if (price === null) throw new RowError('进/出场单价（金额）为必填数字', '进/出场单价（金额）');
        const qty = num(r['进/出场数量']);
        const statusSum = (num(r['在用数量']) || 0) + (num(r['闲置数量']) || 0) + (num(r['报废数量']) || 0) + (num(r['丢失数量']) || 0);
        if (qty !== null && statusSum > 0 && Math.abs(statusSum - qty) > 0.0001) {
          throw new RowError(`在用/闲置/报废/丢失数量合计（${statusSum}）应等于进/出场数量（${qty}）`, '在用数量');
        }
        return {
          data: {
            date: r['日期'] || null,
            sourceCode,
            categoryL1Code,
            categoryFocusCode: codeOf(catFocus, r['资产类别（重点关注）']),
            name,
            spec: String(r['规格型号'] ?? '').trim() || null,
            unit: codeOf(unit, r['单位']),
            qty,
            price,
            receiveUnit: String(r['领用单位/部门'] ?? '').trim() || null,
            responsible: String(r['责任人'] ?? '').trim() || null,
            inUseQty: num(r['在用数量']),
            idleQty: num(r['闲置数量']),
            scrapQty: num(r['报废数量']),
            lostQty: num(r['丢失数量']),
            turnoverCount: num(r['周转次数（含本次）']),
            originalPrice: num(r['原值单价']),
            transferOutPrice: num(r['调出物资本项目进场时单价']),
            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.create(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }
}
