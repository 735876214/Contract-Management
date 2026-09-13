import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, assertVersion, IMPORT_MAX_ROWS } from '../../common/utils/helpers';
import { round4 } from '../../common/utils/money';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { DictService } from '../dict/dict.service';
import { SettlementService } from '../settlement/settlement.service';

const BASE_FIELDS = [
  'name', 'spec', 'categoryLevel1', 'categoryLevel2', 'mdmCode', 'dscCode',
  'unit', 'isAsset', 'isSafetyMaterial', 'status', 'remark',
];
// 统一合同物资清单：排除收入单价/合价、标准成本单价/合价（需求 2.2 排除字段）
const ROW_FIELDS = [
  'contractId', 'materialBaseId', 'unit', 'qty', 'priceBeforeTax', 'taxRatePct', 'remark', 'sortOrder',
];

@Injectable()
export class MaterialService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private styled: StyledExcelService,
    private dict: DictService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private settlement: SettlementService,
    private tasks: ImportTaskService,
  ) {}

  /** 计量单位统一取自字典「measurement_unit」，禁止手输（需求 2.4） */
  private async resolveUnit(unit: any): Promise<string> {
    const raw = String(unit ?? '').trim();
    if (!raw) throw new BadRequestException('计量单位不能为空');
    const units = await this.dict.options('measurement_unit');
    const hit = units.find((u: any) => u.itemName === raw || u.itemCode === raw);
    if (!hit) throw new BadRequestException(`计量单位不在字典范围内，请先在字典管理中添加（当前值：「${raw}」）`);
    return hit.itemName;
  }

  /** 布尔属性归一化（需求 2.1.1：是否资产 / 是否安全物资 必填） */
  private toBool(v: any, label: string): boolean {
    if (v === true || v === false) return v;
    if (v === 1 || v === '1' || v === 'true' || v === 'Y' || v === '是') return true;
    if (v === 0 || v === '0' || v === 'false' || v === 'N' || v === '否') return false;
    throw new BadRequestException(`${label}为必填项`);
  }

  /** 税率统一取自合同主表：子表未填写时按合同税率自动带出（需求 2.4） */
  private async resolveTaxRate(contract: any, taxRatePct: any): Promise<number | null> {
    const raw = num(taxRatePct);
    if (raw !== null) return raw;
    const contractRate = num(contract?.taxRate);
    return contractRate === null ? null : Math.round(contractRate * 10000) / 100;
  }

  /** 业态编码 → 名称（导出表头用） */
  private async industryTypeName(code: string | null | undefined): Promise<string> {
    if (!code) return '';
    try {
      const map = await this.dict.nameMap('industry_type');
      return map[code]?.name || code;
    } catch {
      return code;
    }
  }

  // ==================== 物资基础库 ====================

  async findBases(query: any = {}, maxPageSize = 500) {
    const { skip, take } = paginate(query, maxPageSize);
    const where: any = {};
    if (query.keyword) {
      where.OR = [
        { name: { contains: query.keyword } },
        { spec: { contains: query.keyword } },
        { mdmCode: { contains: query.keyword } },
        { dscCode: { contains: query.keyword } },
      ];
    }
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    if (query.categoryLevel1) where.categoryLevel1 = query.categoryLevel1;
    if (query.categoryLevel2) where.categoryLevel2 = query.categoryLevel2;
    const [list, total] = await Promise.all([
      this.prisma.materialBase.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.materialBase.count({ where }),
    ]);
    // 附带引用计数，便于前端提示删除风险
    const refCounts = await this.prisma.contractMaterial.groupBy({
      by: ['materialBaseId'],
      _count: { _all: true },
      where: { materialBaseId: { in: list.map((i: any) => i.id) } },
    });
    const refMap: Record<string, number> = {};
    refCounts.forEach((r: any) => (refMap[r.materialBaseId] = r._count._all));
    return buildResult(
      list.map((i: any) => ({ ...i, refCount: refMap[i.id] || 0 })),
      total,
      query,
    );
  }

  /** 下拉选料用（仅启用） */
  async baseOptions(keyword?: string) {
    const where: any = { status: 1 };
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { spec: { contains: keyword } },
        { mdmCode: { contains: keyword } },
        { dscCode: { contains: keyword } },
      ];
    }
    return this.prisma.materialBase.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  private async validateBase(data: any) {
    if (!String(data.name || '').trim()) throw new BadRequestException('物资名称不能为空');
    if (!String(data.spec || '').trim()) throw new BadRequestException('规格型号不能为空');
  }

  async createBase(data: any) {
    await this.validateBase(data);
    const payload = pickFields(data, BASE_FIELDS, { label: '物资基础信息' });
    // 需求 2.3.1：计量单位必填，且只能取自字典「measurement_unit」
    payload.unit = await this.resolveUnit(data.unit);
    // 需求 2.1.1：是否资产 / 是否安全物资 为必填布尔属性（由物资基础库统一维护）
    payload.isAsset = this.toBool(data.isAsset, '是否资产');
    payload.isSafetyMaterial = this.toBool(data.isSafetyMaterial, '是否安全物资');
    const dup = await this.prisma.materialBase.findFirst({ where: { name: payload.name, spec: payload.spec } });
    if (dup) throw new BadRequestException('该材料已创建');
    return this.prisma.materialBase.create({ data: payload });
  }

  async updateBase(id: string, data: any) {
    const old = await this.prisma.materialBase.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('物资基础信息不存在');
    await this.validateBase({ ...old, ...data });
    const payload = pickFields(data, BASE_FIELDS, { label: '物资基础信息' });
    // 需求 2.3.1：计量单位创建后不可修改（历史空值允许一次性补齐）
    if (data.unit !== undefined && data.unit !== null && String(data.unit).trim() !== '') {
      const unit = await this.resolveUnit(data.unit);
      if (old.unit && unit !== old.unit) {
        throw new BadRequestException('计量单位创建后不可修改，如需新单位请先在字典管理中添加');
      }
      payload.unit = unit;
    } else {
      delete payload.unit;
    }
    if (data.isAsset !== undefined) payload.isAsset = this.toBool(data.isAsset, '是否资产');
    if (data.isSafetyMaterial !== undefined) {
      payload.isSafetyMaterial = this.toBool(data.isSafetyMaterial, '是否安全物资');
    }
    if (payload.name || payload.spec) {
      const dup = await this.prisma.materialBase.findFirst({
        where: { name: payload.name || old.name, spec: payload.spec || old.spec, id: { not: id } },
      });
      if (dup) throw new BadRequestException('该材料已创建');
    }
    return this.prisma.materialBase.update({ where: { id }, data: payload });
  }

  /** 删除：被合同物资清单引用时阻止（提示改为停用，保留历史合同数据） */
  async removeBase(id: string) {
    const old = await this.prisma.materialBase.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('物资基础信息不存在');
    const refs = await this.prisma.contractMaterial.count({ where: { materialBaseId: id } });
    if (refs > 0) {
      throw new BadRequestException(`该物资已被 ${refs} 条合同物资清单引用，不可删除；如需保留历史合同数据，请改为「停用」`);
    }
    await this.prisma.materialBase.delete({ where: { id } });
    return true;
  }

  /** 停用 / 启用（软删除） */
  async toggleBase(id: string) {
    const old = await this.prisma.materialBase.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('物资基础信息不存在');
    return this.prisma.materialBase.update({ where: { id }, data: { status: old.status === 1 ? 0 : 1 } });
  }

  async exportBases() {
    const res = await this.findBases({ pageSize: 5000 }, IMPORT_MAX_ROWS);
    const columns = [
      { header: '物资名称', key: 'name', width: 26 },
      { header: '规格型号', key: 'spec', width: 18 },
      { header: '一级分类', key: 'categoryLevel1', width: 14 },
      { header: '二级分类', key: 'categoryLevel2', width: 14 },
      { header: '计量单位', key: 'unit', width: 12 },
      { header: '是否资产', key: 'isAssetName', width: 10 },
      { header: '是否安全物资', key: 'isSafetyMaterialName', width: 14 },
      { header: 'MDM编码', key: 'mdmCode', width: 18 },
      { header: 'DSC编码', key: 'dscCode', width: 18 },
      { header: '状态', key: 'statusName', width: 10 },
      { header: '被引用次数', key: 'refCount', width: 12 },
      { header: '备注', key: 'remark', width: 24 },
    ];
    const rows = (res.list as any[]).map((i) => ({
      name: i.name, spec: i.spec,
      categoryLevel1: i.categoryLevel1 || '', categoryLevel2: i.categoryLevel2 || '',
      unit: i.unit || '',
      isAssetName: i.isAsset ? '是' : '否',
      isSafetyMaterialName: i.isSafetyMaterial ? '是' : '否',
      mdmCode: i.mdmCode || '', dscCode: i.dscCode || '',
      statusName: i.status === 1 ? '启用' : '停用', refCount: i.refCount, remark: i.remark || '',
    }));
    return this.excel.export(columns, rows, '物资基础库');
  }

  /** 物资基础库填写模板（需求 3.3，实际字段口径） */
  async templateBases() {
    const units = await this.dict.options('measurement_unit');
    const columns: TemplateColumn[] = [
      { label: '物资名称', key: 'name', required: true, width: 26, example: '螺纹钢 HRB400E' },
      { label: '规格型号', key: 'spec', required: true, width: 18, example: 'Φ20' },
      { label: '一级分类', key: 'categoryLevel1', type: 'text', width: 14, example: '工程材料' },
      { label: '二级分类', key: 'categoryLevel2', type: 'text', width: 14, example: '钢筋' },
      {
        label: '计量单位', key: 'unit', required: true, type: 'select', width: 12, example: '吨(t)',
        options: units.map((u: any) => u.itemName).filter(Boolean),
        desc: '下拉选择，来自字典「计量单位」，创建后不可修改',
      },
      {
        label: '是否资产', key: 'isAsset', required: true, type: 'select', width: 10, example: '否',
        options: ['是', '否'],
      },
      {
        label: '是否安全物资', key: 'isSafetyMaterial', required: true, type: 'select', width: 14, example: '否',
        options: ['是', '否'],
      },
      { label: 'MDM编码', key: 'mdmCode', type: 'text', width: 18, example: 'MDM-GC-001' },
      { label: 'DSC编码', key: 'dscCode', type: 'text', width: 18, example: 'DSC-001' },
      { label: '备注', key: 'remark', type: 'text', width: 24, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '物资基础库', sheetName: '数据', columns });
  }

  /**
   * 批量导入（需求 2.1/2.2）：全成功或全失败
   * - 先逐行校验（必填 + 批内重复 + 数据库唯一约束「物资名称 + 规格型号」）
   * - 任一行失败即返回错误报告，不写入任何数据
   * - 全部通过后在同一事务内写入
   */
  async importBases(buffer: Buffer, meta?: { fileName?: string; user?: any }) {
    const rows = await this.excel.parse(buffer, [2]);
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'material-base', moduleName: '物资基础库', fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r) => {
        const name = String(r['物资名称'] ?? '').trim();
        const spec = String(r['规格型号'] ?? '').trim();
        if (!name) throw new RowError('物资名称为必填项', '物资名称');
        if (!spec) throw new RowError('规格型号为必填项', '规格型号');
        notDup(`${name}|${spec}`, `批内重复：第 ${name} / ${spec} 在导入文件中出现多次`, '物资名称');
        const unitRaw = String(r['计量单位'] ?? '').trim();
        if (!unitRaw) throw new RowError('计量单位为必填项', '计量单位');
        let unit: string;
        try {
          unit = await this.resolveUnit(unitRaw);
        } catch (e: any) {
          throw new RowError(e?.message || '计量单位不在字典范围内', '计量单位');
        }
        const boolOf = (v: any, label: string): boolean => {
          const s = String(v ?? '').trim();
          if (['是', 'Y', 'y', '1', 'true', 'TRUE'].includes(s)) return true;
          if (['否', 'N', 'n', '0', 'false', 'FALSE'].includes(s) || s === '') return false;
          throw new RowError(`${label}仅支持填写「是」或「否」`, label);
        };
        const isAsset = boolOf(r['是否资产'], '是否资产');
        const isSafetyMaterial = boolOf(r['是否安全物资'], '是否安全物资');
        const payload = {
          name, spec, unit, isAsset, isSafetyMaterial,
          categoryLevel1: String(r['一级分类'] ?? '').trim() || null,
          categoryLevel2: String(r['二级分类'] ?? '').trim() || null,
          mdmCode: String(r['MDM编码'] ?? '').trim() || null,
          dscCode: String(r['DSC编码'] ?? '').trim() || null,
          remark: String(r['备注'] ?? '').trim() || null,
        };
        const exist = await this.prisma.materialBase.findFirst({ where: { name, spec } });
        if (exist) {
          const dupOther = await this.prisma.materialBase.findFirst({ where: { name, spec, id: { not: exist.id } } });
          if (dupOther) throw new RowError(`唯一性校验失败：「${name} / ${spec}」存在重复主数据，请先清理`, '物资名称');
          // 需求 2.3.1：计量单位创建后不可修改，已存在记录的既有单位不被导入覆盖
          if (exist.unit && unit !== exist.unit) {
            delete (payload as any).unit;
          }
          return { mode: 'update' as const, id: exist.id, payload };
        }
        return { mode: 'create' as const, payload };
      },
      write: async (plans, tx: TxClient) => {
        let created = 0;
        let updated = 0;
        for (const p of plans) {
          if (p.mode === 'create') {
            await tx.materialBase.create({ data: p.payload });
            created++;
          } else {
            await tx.materialBase.update({ where: { id: p.id }, data: { ...p.payload, version: { increment: 1 } } });
            updated++;
          }
        }
        return { created, updated };
      },
    });
  }

  // ==================== 合同物资清单 ====================

  /** 服务端自动计算派生金额（含税单价/暂定含税合价，基于输入行） */
  private computeAmounts(row: any) {
    const qty = num(row.qty);
    const priceBeforeTax = num(row.priceBeforeTax);
    const taxPct = num(row.taxRatePct);
    const priceWithTax = priceBeforeTax !== null ? round4(priceBeforeTax * (1 + (taxPct || 0) / 100)) : null;
    const totalWithTax = priceWithTax !== null && qty !== null ? round4(qty * priceWithTax) : null;
    return { priceWithTax, totalWithTax };
  }

  private normalizeRow(payload: any) {
    const computed = this.computeAmounts(payload);
    const data: any = pickFields(payload, ROW_FIELDS, { label: '合同物资清单' });
    ['qty', 'priceBeforeTax', 'taxRatePct'].forEach((f) => {
      if (data[f] !== undefined) data[f] = num(data[f]);
    });
    if (data.sortOrder !== undefined) data.sortOrder = Math.trunc(Number(data.sortOrder) || 0);
    return { data, computed };
  }

  /** 按合同查询清单行（含基础物资信息 + 合同头信息），按行号排序 */
  async findRows(contractId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { id: true, name: true } }, project: { select: { name: true, industryType: true } } },
    });
    if (!contract) throw new NotFoundException('合同不存在');
    const list = await this.prisma.contractMaterial.findMany({
      where: { contractId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { materialBase: true },
    });
    return {
      contract: {
        id: contract.id,
        code: contract.code,
        name: contract.name,
        supplierName: (contract as any).supplier?.name || '',
        projectName: (contract as any).project?.name || '',
        industryType: (contract as any).project?.industryType || '',
        signDate: contract.signDate,
      },
      list,
    };
  }

  /**
   * 项目下所有合同物资清单（需求修正3）：平铺展示 + 组合筛选
   * 筛选：供应商名称（模糊）、合同物资名称（模糊）、合同编号（模糊）、合同（精确）
   * 数据按项目隔离
   */
  async findAllRows(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const and: any[] = [{ contract: { projectId } }];
    if (query.contractId) and.push({ contractId: query.contractId });
    if (query.supplierName) {
      and.push({ contract: { supplier: { name: { contains: query.supplierName } } } });
    }
    if (query.materialName) and.push({ materialBase: { name: { contains: query.materialName } } });
    if (query.contractCode) and.push({ contract: { code: { contains: query.contractCode } } });
    const where = { AND: and };
    const [list, total] = await Promise.all([
      this.prisma.contractMaterial.findMany({
        where,
        skip,
        take,
        orderBy: [{ contract: { code: 'asc' } }, { sortOrder: 'asc' }],
        include: {
          materialBase: true,
          contract: { include: { supplier: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.contractMaterial.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  private async assertContract(contractId: string) {    if (!contractId) throw new BadRequestException('缺少合同 ID');
    const contract = await this.prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) throw new NotFoundException('合同不存在');
    return contract;
  }

  private async assertNoDup(contractId: string, materialBaseId: string, excludeId?: string) {
    const dup = await this.prisma.contractMaterial.findFirst({
      where: { contractId, materialBaseId, id: excludeId ? { not: excludeId } : undefined },
    });
    if (dup) throw new BadRequestException('同一物资在当前合同内只能出现一次');
  }

  async createRow(data: any) {
    const contract = await this.assertContract(data.contractId);
    if (!data.materialBaseId) throw new BadRequestException('请从物资基础库中选择物资');
    const base = await this.prisma.materialBase.findUnique({ where: { id: data.materialBaseId } });
    if (!base) throw new NotFoundException('物资基础信息不存在，请先在物资基础库中维护');
    // 计量单位字典校验 + 税率继承合同主表
    data.unit = await this.resolveUnit(data.unit);
    const taxRate = await this.resolveTaxRate(contract, data.taxRatePct);
    if (taxRate !== null) data.taxRatePct = taxRate;
    await this.assertNoDup(data.contractId, data.materialBaseId);
    const { data: payload, computed } = this.normalizeRow(data);
    const maxSort = await this.prisma.contractMaterial.aggregate({
      where: { contractId: data.contractId },
      _max: { sortOrder: true },
    });
    const row = await this.prisma.contractMaterial.create({
      data: {
        ...payload,
        priceWithTax: computed.priceWithTax,
        totalWithTax: computed.totalWithTax,
        sortOrder: payload.sortOrder ?? (maxSort._max.sortOrder || 0) + 1,
      },
      include: { materialBase: true },
    });
    // 需求 2.3：物资变更 → 自动重新派生该合同的结算台账
    await this.settlement.syncLedgerByContract(row.contractId);
    return row;
  }

  async updateRow(id: string, data: any) {
    const old = await this.prisma.contractMaterial.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('合同物资清单行不存在');
    assertVersion(old, data); // 乐观锁：版本号不一致说明已被他人修改
    const contract = await this.assertContract(old.contractId);
    if (data.unit !== undefined) data.unit = await this.resolveUnit(data.unit ?? old.unit);
    const taxRate = await this.resolveTaxRate(contract, data.taxRatePct ?? old.taxRatePct);
    if (taxRate !== null) data.taxRatePct = taxRate;
    const merged: any = { ...old, ...data };
    if (data.materialBaseId && data.materialBaseId !== old.materialBaseId) {
      const base = await this.prisma.materialBase.findUnique({ where: { id: data.materialBaseId } });
      if (!base) throw new NotFoundException('物资基础信息不存在');
      await this.assertNoDup(old.contractId, data.materialBaseId, id);
    }
    if (!String(merged.unit || '').trim()) throw new BadRequestException('计量单位不能为空');
    const { data: payload, computed } = this.normalizeRow(data);
    const row = await this.prisma.contractMaterial.update({
      where: { id },
      data: {
        ...payload,
        priceWithTax: computed.priceWithTax,
        totalWithTax: computed.totalWithTax,
        version: { increment: 1 },
      },
      include: { materialBase: true },
    });
    // 需求 2.3：物资变更 → 自动重新派生该合同的结算台账
    await this.settlement.syncLedgerByContract(row.contractId);
    return row;
  }

  async removeRow(id: string) {
    const old = await this.prisma.contractMaterial.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('合同物资清单行不存在');
    await this.prisma.contractMaterial.delete({ where: { id } });
    // 需求 2.3：物资变更 → 自动重新派生该合同的结算台账
    await this.settlement.syncLedgerByContract(old.contractId);
    return true;
  }

  /** 行号调整：接收 [{ id, sortOrder }] 全量重排 */
  async sortRows(items: { id: string; sortOrder: number }[]) {
    if (!Array.isArray(items) || !items.length) throw new BadRequestException('缺少排序数据');
    for (const it of items) {
      await this.prisma.contractMaterial.update({
        where: { id: it.id },
        data: { sortOrder: Math.trunc(Number(it.sortOrder) || 0) },
      });
    }
    return true;
  }

  /**
   * 上传导入数据（统一口径，需求 3.4 / 6.3 / 6.4）：
   * - 仅支持填写模板格式（第 2 行为示例行，自动忽略）
   * - 物资名称+规格型号 须在物资基础库中存在（关联校验）
   * - 同一合同下物资名称+规格型号不能重复（唯一性校验）
   * - 默认为新增数据，不覆盖已有数据（重复即报行级错误）
   * - 全部校验通过不等于部分写入：任一行失败仅记录错误，其余行照常入库
   */
  async importRows(contractId: string, buffer: Buffer, meta?: { fileName?: string; user?: any }) {
    const contract = await this.assertContract(contractId);
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为示例行
    const maxSort = (await this.prisma.contractMaterial.aggregate({ where: { contractId }, _max: { sortOrder: true } }))._max.sortOrder || 0;
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'contract-material', moduleName: '合同物资清单', fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r, { index }) => {
        const name = String(r['物资名称'] ?? '').trim();
        const spec = String(r['规格型号'] ?? '').trim();
        if (!name) throw new RowError('物资名称为必填项', '物资名称');
        if (!spec) throw new RowError('规格型号为必填项', '规格型号');
        const unit = await this.resolveUnit(r['计量单位']);
        const qty = num(r['暂定数量']);
        const price = num(r['税前单价']);
        let tax = num(r['税率']);
        if (qty === null) throw new RowError('暂定数量为必填数字', '暂定数量');
        if (price === null) throw new RowError('税前单价为必填数字', '税前单价');
        // 税率未填时按合同主表税率自动带出
        tax = tax === null ? await this.resolveTaxRate(contract, null) : tax;
        if (tax === null) throw new RowError('税率为必填数字（如 13 表示 13%），或先在合同台账中维护税率', '税率');
        const base = await this.prisma.materialBase.findFirst({ where: { name, spec } });
        if (!base) throw new RowError(`关联校验失败：物资基础库中不存在「${name} / ${spec}」，请先维护物资基础库`, '物资名称');
        // 唯一性：合同编号 + 物资名称 + 规格型号（数据库唯一约束 + 批内去重）
        notDup(`${contractId}|${base.id}`, `批内重复：「${name} / ${spec}」在导入文件中出现多次`, '物资名称');
        const dup = await this.prisma.contractMaterial.findUnique({
          where: { contractId_materialBaseId: { contractId, materialBaseId: base.id } },
        });
        if (dup) throw new RowError(`唯一性校验失败：该合同下已存在「${name} / ${spec}」，导入不覆盖已有数据`, '物资名称');
        const computed = this.computeAmounts({ qty, priceBeforeTax: price, taxRatePct: tax });
        return {
          contractId,
          materialBaseId: base.id,
          unit,
          qty,
          priceBeforeTax: price,
          taxRatePct: tax,
          remark: String(r['备注'] ?? '').trim() || null,
          sortOrder: maxSort + index + 1,
          priceWithTax: computed.priceWithTax,
          totalWithTax: computed.totalWithTax,
        };
      },
      write: async (plans, tx: TxClient) => {
        for (const p of plans) await tx.contractMaterial.create({ data: p });
        // 需求 2.3：物资变更 → 自动重新派生该合同的结算台账
        await this.settlement.syncLedgerByContract(contractId, tx);
        return { created: plans.length };
      },
    });
  }

  /** 填写模板（需求 3.3）：下拉/数字/格式验证 + 示例行 */
  async templateRows() {
    const units = await this.dict.options('measurement_unit');
    const columns: TemplateColumn[] = [
      { label: '物资名称', key: 'name', required: true, width: 24, example: '螺纹钢 HRB400E', desc: '须与物资基础库中的物资名称一致' },
      { label: '规格型号', key: 'spec', required: true, width: 18, example: 'Φ20', desc: '须与物资基础库中的规格型号一致' },
      {
        label: '计量单位', key: 'unit', required: true, type: 'select', width: 12, example: '吨',
        options: units.map((u: any) => u.itemName).filter(Boolean), desc: '下拉选择，来自字典「计量单位」',
      },
      { label: '暂定数量', key: 'qty', required: true, type: 'qty', width: 14, example: 1200 },
      { label: '税前单价', key: 'priceBeforeTax', required: true, type: 'money', width: 14, example: 3850 },
      { label: '税率', key: 'taxRatePct', required: true, type: 'number', width: 10, example: 13, desc: '百分比数字，常见值 13、9、6、3、1（如 13 表示 13%）' },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '合同物资清单', sheetName: '数据', columns });
  }

  /**
   * 派生清单（需求 2.3）：从物资基础库（项目物资清单数据源）按选定物资重新生成
   * 重新编号（序号从 1 开始），仅复制统一字段模型中的字段，自动计算含税单价与暂定含税合价。
   */
  async derive(contractId: string, materialIds: string[]) {
    await this.assertContract(contractId);
    if (!Array.isArray(materialIds) || !materialIds.length) {
      throw new BadRequestException('请选择要派生的物资（来自物资基础库）');
    }
    const bases = await this.prisma.materialBase.findMany({ where: { id: { in: materialIds }, status: 1 } });
    if (!bases.length) throw new BadRequestException('所选物资不存在或已停用');
    await this.prisma.contractMaterial.deleteMany({ where: { contractId } });
    for (const [i, base] of bases.entries()) {
      // 物资基础库只提供名称/规格/编码等主数据，派生行的数量/价格/税率
      // 由用户补录后按统一规则自动计算（含税单价 = 税前单价 × (1 + 税率/100)）
      await this.prisma.contractMaterial.create({
        data: {
          contractId,
          materialBaseId: base.id,
          // 需求 2.3.2：计量单位默认从物资基础库带出（后续可手动改为字典内的其他单位）
          unit: base.unit || '',
          qty: null,
          priceBeforeTax: null,
          taxRatePct: null,
          priceWithTax: null,
          totalWithTax: null,
          sortOrder: i + 1,
          remark: '由物资基础库派生',
        },
      });
    }
    return { created: bases.length, removed: true };
  }

  /**
   * 独立导出（统一字段模型，需求 2.2）：固定头部（合同名称/供应商/合同编号/项目名称）+ 明细行
   * 排除字段：收入单价/合价、标准成本单价/合价、MDM/DSC 编码不出现在合同清单中
   * format: xlsx | csv
   */
  async exportRows(contractId: string, format: 'xlsx' | 'csv' = 'xlsx'): Promise<{ buffer: Buffer; filename: string; mime: string }> {
    const { contract, list } = await this.findRows(contractId);
    const headers = [
      '序号', '合同编号', '项目名称', '供应商名称', '物资名称', '规格型号', '计量单位',
      '暂定数量', '税前单价', '税率(%)', '含税单价', '暂定含税合价', '备注',
    ];
    const rows = (list as any[]).map((r, i) => [
      i + 1,
      contract.code || '',
      contract.projectName || '',
      contract.supplierName || '',
      r.materialBase?.name || '',
      r.materialBase?.spec || '',
      r.unit || '',
      num(r.qty) ?? '',
      num(r.priceBeforeTax) ?? '',
      num(r.taxRatePct) ?? '',
      num(r.priceWithTax) ?? '',
      num(r.totalWithTax) ?? '',
      r.remark || '',
    ]);

    if (format === 'csv') {
      const esc = (v: any) => {
        const s = String(v ?? '');
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines: string[] = [];
      lines.push(`合同名称,${esc(contract.name)}`);
      lines.push(`供应商名称,${esc(contract.supplierName)}`);
      lines.push(`合同编号,${esc(contract.code)}`);
      lines.push(`项目名称,${esc(contract.projectName)}`);
      lines.push(`项目业态,${esc(await this.industryTypeName(contract.industryType))}`);
      lines.push('');
      lines.push(headers.map(esc).join(','));
      rows.forEach((r) => lines.push(r.map(esc).join(',')));
      // BOM：保证 Excel 打开中文不乱码
      return {
        buffer: Buffer.from('\ufeff' + lines.join('\r\n'), 'utf-8'),
        filename: `contract-materials-${contract.code || contract.id}.csv`,
        mime: 'text/csv; charset=utf-8',
      };
    }

    const wb = await import('exceljs');
    const ExcelJS = wb.default || wb;
    const workbook = new (ExcelJS as any).Workbook();
    const ws = workbook.addWorksheet('合同物资清单');
    // 中建 logo 表头（第 1~2 行）
    this.styled.writeLogoHeader(ws as any, { title: '合同物资清单', lastCol: headers.length });
    // 合同头信息（固定头部）
    ws.addRow(['合同名称', contract.name || '']);
    ws.addRow(['供应商名称', contract.supplierName || '']);
    ws.addRow(['合同编号', contract.code || '']);
    ws.addRow(['项目名称', contract.projectName || '']);
    ws.addRow(['项目业态', await this.industryTypeName(contract.industryType)]);
    ws.addRow([]);
    const headerRowIndex = ws.rowCount + 1;
    ws.addRow(headers).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));
    ws.columns = headers.map((h, i) => ({ header: h, width: h.length > 6 ? 16 : 12 }));
    ws.getColumn(5).width = 26; // 物资名称
    ws.getColumn(13).width = 24; // 备注
    const buf = await workbook.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(buf),
      filename: `contract-materials-${contract.code || contract.id}.xlsx`,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
}
