import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { DictService } from '../dict/dict.service';

const BASE_FIELDS = ['name', 'spec', 'mdmCode', 'dscCode', 'status', 'remark'];
const ROW_FIELDS = [
  'contractId', 'materialBaseId', 'unit', 'qty', 'priceBeforeTax', 'taxRatePct',
  'remark', 'incomePrice', 'stdPrice', 'sortOrder',
];

/** 金额四舍五入到 4 位小数（模拟 BigDecimal 精度控制，避免浮点误差累积） */
function round(n: number | null | undefined, digits = 4): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const p = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * p) / p;
}

@Injectable()
export class MaterialService {
  constructor(private prisma: PrismaClient, private excel: ExcelService, private dict: DictService) {}

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

  async findBases(query: any = {}) {
    const { skip, take } = paginate(query);
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
    const dup = await this.prisma.materialBase.findFirst({ where: { name: payload.name, spec: payload.spec } });
    if (dup) throw new BadRequestException('相同「物资名称 + 规格型号」的基础物资已存在');
    return this.prisma.materialBase.create({ data: payload });
  }

  async updateBase(id: string, data: any) {
    const old = await this.prisma.materialBase.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('物资基础信息不存在');
    await this.validateBase({ ...old, ...data });
    const payload = pickFields(data, BASE_FIELDS, { label: '物资基础信息' });
    if (payload.name || payload.spec) {
      const dup = await this.prisma.materialBase.findFirst({
        where: { name: payload.name || old.name, spec: payload.spec || old.spec, id: { not: id } },
      });
      if (dup) throw new BadRequestException('相同「物资名称 + 规格型号」的基础物资已存在');
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
    const res = await this.findBases({ pageSize: 5000 });
    const columns = [
      { header: '物资名称', key: 'name', width: 26 },
      { header: '规格型号', key: 'spec', width: 18 },
      { header: 'MDM编码', key: 'mdmCode', width: 18 },
      { header: 'DSC编码', key: 'dscCode', width: 18 },
      { header: '状态', key: 'statusName', width: 10 },
      { header: '被引用次数', key: 'refCount', width: 12 },
      { header: '备注', key: 'remark', width: 24 },
    ];
    const rows = (res.list as any[]).map((i) => ({
      name: i.name, spec: i.spec, mdmCode: i.mdmCode || '', dscCode: i.dscCode || '',
      statusName: i.status === 1 ? '启用' : '停用', refCount: i.refCount, remark: i.remark || '',
    }));
    return this.excel.export(columns, rows, '物资基础库');
  }

  /** 批量导入：按「物资名称+规格型号」匹配，存在则更新，否则新建 */
  async importBases(buffer: Buffer) {
    const rows = await this.excel.parse(buffer);
    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      try {
        const name = String(r['物资名称'] ?? '').trim();
        const spec = String(r['规格型号'] ?? '').trim();
        if (!name || !spec) throw new Error('物资名称与规格型号均为必填');
        const payload = {
          name, spec,
          mdmCode: String(r['MDM编码'] ?? '').trim() || null,
          dscCode: String(r['DSC编码'] ?? '').trim() || null,
          remark: String(r['备注'] ?? '').trim() || null,
        };
        const exist = await this.prisma.materialBase.findFirst({ where: { name, spec } });
        if (exist) {
          await this.prisma.materialBase.update({ where: { id: exist.id }, data: payload });
          updated++;
        } else {
          await this.prisma.materialBase.create({ data: payload });
          created++;
        }
      } catch (e: any) {
        errors.push(`第 ${index + 2} 行：${e.message}`);
      }
    }
    return { created, updated, errors };
  }

  // ==================== 合同物资清单 ====================

  /** 服务端自动计算派生金额（基于输入行） */
  private computeAmounts(row: any) {
    const qty = num(row.qty);
    const priceBeforeTax = num(row.priceBeforeTax);
    const taxPct = num(row.taxRatePct);
    const incomePrice = num(row.incomePrice);
    const stdPrice = num(row.stdPrice);
    return {
      priceWithTax: priceBeforeTax !== null ? round(priceBeforeTax * (1 + (taxPct || 0) / 100)) : null,
      totalWithTax: null as number | null,
      incomeTotal: incomePrice !== null && qty !== null ? round(qty * incomePrice) : null,
      stdTotal: stdPrice !== null && qty !== null ? round(qty * stdPrice) : null,
    };
  }

  private normalizeRow(payload: any) {
    const computed = this.computeAmounts(payload);
    const qty = num(payload.qty);
    if (computed.priceWithTax !== null && qty !== null) {
      computed.totalWithTax = round(qty * computed.priceWithTax);
    }
    const data: any = pickFields(payload, ROW_FIELDS, { label: '合同物资清单' });
    ['qty', 'priceBeforeTax', 'taxRatePct', 'incomePrice', 'stdPrice'].forEach((f) => {
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

  private async assertContract(contractId: string) {
    if (!contractId) throw new BadRequestException('缺少合同 ID');
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
    await this.assertContract(data.contractId);
    if (!data.materialBaseId) throw new BadRequestException('请从物资基础库中选择物资');
    const base = await this.prisma.materialBase.findUnique({ where: { id: data.materialBaseId } });
    if (!base) throw new NotFoundException('物资基础信息不存在，请先在物资基础库中维护');
    if (!String(data.unit || '').trim()) throw new BadRequestException('计量单位不能为空');
    await this.assertNoDup(data.contractId, data.materialBaseId);
    const { data: payload, computed } = this.normalizeRow(data);
    const maxSort = await this.prisma.contractMaterial.aggregate({
      where: { contractId: data.contractId },
      _max: { sortOrder: true },
    });
    return this.prisma.contractMaterial.create({
      data: {
        ...payload,
        priceWithTax: computed.priceWithTax,
        totalWithTax: computed.totalWithTax,
        incomeTotal: computed.incomeTotal,
        stdTotal: computed.stdTotal,
        sortOrder: payload.sortOrder ?? (maxSort._max.sortOrder || 0) + 1,
      },
      include: { materialBase: true },
    });
  }

  async updateRow(id: string, data: any) {
    const old = await this.prisma.contractMaterial.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('合同物资清单行不存在');
    const merged: any = { ...old, ...data };
    if (data.materialBaseId && data.materialBaseId !== old.materialBaseId) {
      const base = await this.prisma.materialBase.findUnique({ where: { id: data.materialBaseId } });
      if (!base) throw new NotFoundException('物资基础信息不存在');
      await this.assertNoDup(old.contractId, data.materialBaseId, id);
    }
    if (!String(merged.unit || '').trim()) throw new BadRequestException('计量单位不能为空');
    const { data: payload, computed } = this.normalizeRow(data);
    return this.prisma.contractMaterial.update({
      where: { id },
      data: {
        ...payload,
        ...(Object.keys(computed).length
          ? {
              priceWithTax: computed.priceWithTax,
              totalWithTax: computed.totalWithTax,
              incomeTotal: computed.incomeTotal,
              stdTotal: computed.stdTotal,
            }
          : {}),
      },
      include: { materialBase: true },
    });
  }

  async removeRow(id: string) {
    const old = await this.prisma.contractMaterial.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('合同物资清单行不存在');
    await this.prisma.contractMaterial.delete({ where: { id } });
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

  /** 批量导入：按「物资名称+规格型号」匹配基础库，匹配失败则报行级错误 */
  async importRows(contractId: string, buffer: Buffer) {
    await this.assertContract(contractId);
    const rows = await this.excel.parse(buffer);
    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      try {
        const name = String(r['物资名称'] ?? '').trim();
        const spec = String(r['规格型号'] ?? '').trim();
        const unit = String(r['计量单位'] ?? '').trim();
        if (!name || !spec) throw new Error('物资名称与规格型号均为必填');
        if (!unit) throw new Error('计量单位为必填');
        const base = await this.prisma.materialBase.findFirst({ where: { name, spec } });
        if (!base) throw new Error(`基础库中不存在「${name} / ${spec}」，请先维护物资基础库`);
        const payload = {
          contractId,
          materialBaseId: base.id,
          unit,
          qty: num(r['暂定数量']),
          priceBeforeTax: num(r['税前单价']),
          taxRatePct: num(r['增值税']),
          incomePrice: num(r['收入单价']),
          stdPrice: num(r['标准成本单价']),
          remark: String(r['备注'] ?? '').trim() || null,
        };
        const exist = await this.prisma.contractMaterial.findUnique({
          where: { contractId_materialBaseId: { contractId, materialBaseId: base.id } },
        });
        if (exist) {
          await this.updateRow(exist.id, payload);
          updated++;
        } else {
          await this.createRow(payload);
          created++;
        }
      } catch (e: any) {
        errors.push(`第 ${index + 2} 行：${e.message}`);
      }
    }
    return { created, updated, errors };
  }

  /**
   * 独立导出：固定头部（合同名称/供应商/合同编号）+ 明细行
   * format: xlsx | csv
   */
  async exportRows(contractId: string, format: 'xlsx' | 'csv' = 'xlsx'): Promise<{ buffer: Buffer; filename: string; mime: string }> {
    const { contract, list } = await this.findRows(contractId);
    const headers = [
      '序号', '物资名称', '规格型号', 'MDM编码', 'DSC编码', '计量单位',
      '暂定数量', '税前单价', '增值税(%)', '含税单价', '暂定含税合价', '备注',
      '收入单价', '收入合价', '标准成本单价', '标准成本合价',
    ];
    const rows = (list as any[]).map((r, i) => [
      i + 1,
      r.materialBase?.name || '',
      r.materialBase?.spec || '',
      r.materialBase?.mdmCode || '',
      r.materialBase?.dscCode || '',
      r.unit || '',
      num(r.qty) ?? '',
      num(r.priceBeforeTax) ?? '',
      num(r.taxRatePct) ?? '',
      num(r.priceWithTax) ?? '',
      num(r.totalWithTax) ?? '',
      r.remark || '',
      num(r.incomePrice) ?? '',
      num(r.incomeTotal) ?? '',
      num(r.stdPrice) ?? '',
      num(r.stdTotal) ?? '',
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
    ws.getColumn(2).width = 26;
    ws.getColumn(12).width = 24;
    const buf = await workbook.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(buf),
      filename: `contract-materials-${contract.code || contract.id}.xlsx`,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
}
