import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult } from '../../common/utils/helpers';
import { ExcelService } from '../../common/services/excel.service';
import { SysParamService } from '../../common/services/sys-param.service';

/**
 * 字典服务：
 * - 全系统下拉/枚举唯一数据源
 * - 内存缓存，字典变更自动刷新
 * - 提供字典项引用校验（被业务数据引用不可删除）
 */
@Injectable()
export class DictService {
  private readonly logger = new Logger(DictService.name);
  private cache: Map<string, any[]> = new Map();

  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private sysParam: SysParamService,
  ) {}

  // ---------------- 缓存 ----------------
  async refreshCache(typeCode?: string) {
    if (typeCode) this.cache.delete(typeCode);
    else this.cache.clear();
  }

  /** 获取启用中的字典项（带缓存） */
  async options(typeCode: string, extValue?: string) {
    let items = this.cache.get(typeCode);
    if (!items) {
      items = await this.prisma.dictItem.findMany({
        where: { typeCode, status: 1 },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      this.cache.set(typeCode, items);
    }
    if (extValue) return items.filter((i: any) => !i.extField1 || i.extField1 === extValue);
    return items;
  }

  /** 获取字典项名称映射（用于列表展示翻译） */
  async nameMap(typeCode: string): Promise<Record<string, { name: string; color?: string }>> {
    const items = await this.options(typeCode);
    return items.reduce((acc: any, i: any) => {
      acc[i.itemCode] = { name: i.itemName, color: i.color };
      return acc;
    }, {});
  }

  /** 校验字典值合法性（后端枚举校验读字典，不硬编码） */
  async validate(typeCode: string, value: any, required = false): Promise<string | null> {
    if (value === undefined || value === null || value === '') {
      if (required) throw new BadRequestException(`字典[${typeCode}]取值不能为空`);
      return null;
    }
    const items = await this.options(typeCode);
    if (!items.some((i: any) => i.itemCode === value)) {
      throw new BadRequestException(`字典[${typeCode}]中不存在取值：${value}`);
    }
    return value;
  }

  /** 批量校验 */
  async validateMany(pairs: { typeCode: string; value: any; required?: boolean }[]) {
    for (const p of pairs) await this.validate(p.typeCode, p.value, p.required);
  }

  // ---------------- 字典类型 ----------------
  async findTypes(query: any = {}) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.keyword) {
      where.OR = [{ code: { contains: query.keyword } }, { name: { contains: query.keyword } }];
    }
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    const [list, total] = await Promise.all([
      this.prisma.dictType.findMany({ where, skip, take, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.dictType.count({ where }),
    ]);
    // 附带字典项数量
    const counts = await this.prisma.dictItem.groupBy({ by: ['typeCode'], _count: { _all: true } });
    const countMap = counts.reduce((acc: any, c: any) => ({ ...acc, [c.typeCode]: c._count._all }), {});
    return buildResult(
      list.map((t: any) => ({ ...t, itemCount: countMap[t.code] || 0 })),
      total,
      query,
    );
  }

  async createType(data: any) {
    if (!data.code) throw new BadRequestException('字典类型编码不能为空');
    const exist = await this.prisma.dictType.findUnique({ where: { code: data.code } });
    if (exist) throw new BadRequestException('字典类型编码已存在');
    return this.prisma.dictType.create({ data });
  }

  async updateType(id: string, data: any) {
    const type = await this.prisma.dictType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('字典类型不存在');
    if (data.code && data.code !== type.code) {
      const exist = await this.prisma.dictType.findUnique({ where: { code: data.code } });
      if (exist) throw new BadRequestException('字典类型编码已存在');
      await this.prisma.dictItem.updateMany({ where: { typeCode: type.code }, data: { typeCode: data.code } });
      await this.refreshCache(type.code);
    }
    return this.prisma.dictType.update({ where: { id }, data });
  }

  async removeType(id: string) {
    const type = await this.prisma.dictType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('字典类型不存在');
    const usage = await this.checkTypeUsage(type.code);
    if (usage.used) throw new BadRequestException(`该字典类型已被业务数据引用（${usage.count} 处），不可删除`);
    await this.prisma.dictItem.deleteMany({ where: { typeCode: type.code } });
    await this.prisma.dictType.delete({ where: { id } });
    await this.refreshCache(type.code);
    return true;
  }

  // ---------------- 字典项 ----------------
  async findItems(query: any = {}) {
    const where: any = {};
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.keyword) {
      where.OR = [{ itemName: { contains: query.keyword } }, { itemCode: { contains: query.keyword } }];
    }
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    const list = await this.prisma.dictItem.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return list;
  }

  async createItem(data: any) {
    if (!data.typeCode || !data.itemCode || !data.itemName) throw new BadRequestException('字典类型、编码与名称不能为空');
    const exist = await this.prisma.dictItem.findUnique({
      where: { typeCode_itemCode: { typeCode: data.typeCode, itemCode: data.itemCode } },
    });
    if (exist) throw new BadRequestException('同一字典类型下字典项编码已存在');
    const item = await this.prisma.dictItem.create({ data });
    await this.refreshCache(data.typeCode);
    return item;
  }

  async updateItem(id: string, data: any) {
    const item = await this.prisma.dictItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('字典项不存在');
    const updated = await this.prisma.dictItem.update({ where: { id }, data });
    await this.refreshCache(item.typeCode);
    return updated;
  }

  async toggleItem(id: string) {
    const item = await this.prisma.dictItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('字典项不存在');
    const updated = await this.prisma.dictItem.update({ where: { id }, data: { status: item.status === 1 ? 0 : 1 } });
    await this.refreshCache(item.typeCode);
    return updated;
  }

  async removeItem(id: string) {
    const item = await this.prisma.dictItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('字典项不存在');
    const usage = await this.checkItemUsage(item.typeCode, item.itemCode);
    if (usage.count > 0) {
      throw new BadRequestException(`该选项已被使用（${usage.count} 处，${usage.tables.join('、')}），不可删除，仅可停用`);
    }
    await this.prisma.dictItem.delete({ where: { id } });
    await this.refreshCache(item.typeCode);
    return true;
  }

  async sortItems(payload: { typeCode: string; ids: string[] }) {
    await Promise.all(payload.ids.map((id, index) => this.prisma.dictItem.update({ where: { id }, data: { sortOrder: index } })));
    await this.refreshCache(payload.typeCode);
    return true;
  }

  // ---------------- 引用检查 ----------------
  /** 字典类型 -> 业务表字段映射 */
  private usageMap: Record<string, { model: string; label: string; fields: string[] }[]> = {
    contract_type: [{ model: 'contract', label: '合同', fields: ['typeCode'] }],
    contract_execution_status: [{ model: 'contract', label: '合同', fields: ['execStatus'] }],
    supplement_agreement_type: [{ model: 'contract', label: '合同', fields: ['supplementTypeCode'] }],
    asset_status: [{ model: 'dailyReport', label: '日报', fields: ['assetStatus'] }],
    material_source: [{ model: 'dailyReport', label: '日报', fields: ['sourceCode'] }],
    material_category: [{ model: 'dailyReport', label: '日报', fields: ['materialCategory'] }],
    material_type: [{ model: 'dailyReport', label: '日报', fields: ['materialType'] }],
    measurement_unit: [{ model: 'dailyReport', label: '日报', fields: ['unit'] }],
    settlement_type: [{ model: 'settlement', label: '结算单', fields: ['typeCode'] }],
    settlement_status: [{ model: 'settlement', label: '结算单', fields: ['statusCode'] }],
    payment_method: [{ model: 'contract', label: '合同', fields: ['paymentMethodCode'] }, { model: 'paymentRecord', label: '付款记录', fields: ['methodCode'] }],
    payment_status: [{ model: 'paymentRecord', label: '付款记录', fields: ['statusCode'] }],
    project_status: [{ model: 'project', label: '项目', fields: ['status'] }],
    invoice_type: [{ model: 'invoice', label: '发票', fields: ['typeCode'] }],
    invoice_status: [{ model: 'invoice', label: '发票', fields: ['statusCode'] }],
    invoice_review_status: [{ model: 'invoice', label: '发票', fields: ['reviewStatus'] }],
    finance_transfer_status: [{ model: 'invoice', label: '发票', fields: ['financeTransferStatus'] }],
    goods_category: [{ model: 'invoice', label: '发票', fields: ['goodsCategory'] }],
    procurement_source: [{ model: 'contractExt', label: '合同扩展', fields: ['procurementSrc'] }],
    supplier_category: [{ model: 'contractExt', label: '合同扩展', fields: ['supplierCategory'] }],
    is_direct_purchase: [{ model: 'contractExt', label: '合同扩展', fields: ['isDirectPurchase'] }],
    yes_no: [
      { model: 'contract', label: '合同', fields: ['isFramework', 'isSupplement'] },
      { model: 'dailyReport', label: '日报', fields: ['isAsset', 'isWeighed', 'isProxy'] },
      { model: 'settlementLedger', label: '结算台账', fields: ['isOnAccount'] },
    ],
    contract_template_category: [{ model: 'contractTemplate', label: '合同模板', fields: ['categoryCode'] }],
  };

  /** 检查字典项是否被业务数据引用 */
  async checkItemUsage(typeCode: string, itemCode: string) {
    const targets = this.usageMap[typeCode] || [];
    let count = 0;
    const tables: string[] = [];
    for (const t of targets) {
      const model = (this.prisma as any)[t.model];
      if (!model) continue;
      const c = await model.count({ where: { OR: t.fields.map((f) => ({ [f]: itemCode })) } });
      if (c > 0) {
        count += c;
        tables.push(`${t.label}(${c})`);
      }
    }
    return { count, tables };
  }

  async checkTypeUsage(typeCode: string) {
    const items = await this.prisma.dictItem.findMany({ where: { typeCode } });
    let count = 0;
    for (const item of items) {
      const u = await this.checkItemUsage(typeCode, item.itemCode);
      count += u.count;
    }
    return { used: count > 0, count };
  }

  /** 按字典项ID查询引用情况 */
  async itemUsageById(id: string) {
    const item = await this.prisma.dictItem.findUnique({ where: { id } });
    if (!item) return { count: 0, tables: [] };
    return this.checkItemUsage(item.typeCode, item.itemCode);
  }

  // ---------------- 导入导出 ----------------
  async exportItems(typeCode: string) {
    const type = await this.prisma.dictType.findUnique({ where: { code: typeCode } });
    const items = await this.findItems({ typeCode });
    const columns = [
      { header: '字典项编码', key: 'itemCode', width: 20 },
      { header: '字典项名称', key: 'itemName', width: 24 },
      { header: '排序号', key: 'sortOrder', width: 10 },
      { header: '状态', key: 'status', width: 10 },
      { header: '颜色', key: 'color', width: 12 },
      { header: '扩展字段1', key: 'extField1', width: 18 },
      { header: '备注', key: 'remark', width: 30 },
    ];
    const rows = items.map((i: any) => ({
      itemCode: i.itemCode,
      itemName: i.itemName,
      sortOrder: i.sortOrder,
      status: i.status === 1 ? '启用' : '停用',
      color: i.color,
      extField1: i.extField1,
      remark: i.remark,
    }));
    return this.excel.export(columns, rows, type?.name || typeCode);
  }

  async importItems(typeCode: string, buffer: Buffer) {
    const rows = await this.excel.parse(buffer);
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      const itemCode = String(r['字典项编码'] ?? '').trim();
      const itemName = String(r['字典项名称'] ?? '').trim();
      if (!itemCode || !itemName) continue;
      const data: any = {
        itemName,
        sortOrder: Number(r['排序号']) || 0,
        status: String(r['状态'] ?? '启用') === '停用' ? 0 : 1,
        color: r['颜色'] || null,
        extField1: r['扩展字段1'] || null,
        remark: r['备注'] || null,
      };
      const exist = await this.prisma.dictItem.findUnique({ where: { typeCode_itemCode: { typeCode, itemCode } } });
      if (exist) {
        await this.prisma.dictItem.update({ where: { id: exist.id }, data });
        updated++;
      } else {
        await this.prisma.dictItem.create({ data: { typeCode, itemCode, ...data } });
        created++;
      }
    }
    await this.refreshCache(typeCode);
    return { created, updated };
  }
}
