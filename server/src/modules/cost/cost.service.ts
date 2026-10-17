import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';
import { round } from '../../common/utils/money';
import { pickFields } from '../../common/pick-fields';
import { StyledExcelService } from '../../common/services/styled-excel.service';

/**
 * 成本管理（附件需求 2026-10-17 新增一级模块）：分包领用汇总 + 降本创效主材盈亏分析。
 * 两张表都是**结构化台账 + Excel 导出**（无上传附件——业务口径 2026-10-17 修正 4）。
 *
 * 派生值**服务端算、不接受直传**（防两套口径）：
 * - 领用金额 `amount` = qty × unitPrice；
 * - 盈亏额 `profitLoss` = 结算额 − 实际成本（可为负）；盈亏率 = 盈亏额 ÷ 结算额（结算额 0/空 → null）。
 */

const RECEIVING_FIELDS = [
  'subcontractorId', 'subcontractorName', 'period', 'materialName', 'spec', 'unit',
  'qty', 'unitPrice', 'useLocation', 'remark',
];
// 旧手工台账 ProfitLossAnalysis 已删除（2026-10-17 第三批：月度盈亏分析见 monthly-profit-loss.service.ts）

@Injectable()
export class CostService {
  constructor(
    private prisma: PrismaClient,
    private styled: StyledExcelService,
  ) {}

  // ==================== 分包领用汇总 ====================

  async listReceiving(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.subcontractorId) where.subcontractorId = query.subcontractorId;
    if (query.period) where.period = query.period;
    if (query.keyword) {
      where.OR = [
        { subcontractorName: { contains: query.keyword } },
        { materialName: { contains: query.keyword } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.subcontractReceiving.findMany({ where, skip, take, orderBy: [{ period: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.subcontractReceiving.count({ where }),
    ]);
    return buildResult(rows.map((r) => this.serializeReceiving(r)), total, query);
  }

  async getReceiving(id: string) {
    const r = await this.prisma.subcontractReceiving.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('分包领用记录不存在');
    return this.serializeReceiving(r);
  }

  async createReceiving(data: any, projectId: string, user: any) {
    const payload = await this.buildReceivingPayload(data, projectId);
    payload.createdBy = user?.id;
    const created = await this.prisma.subcontractReceiving.create({ data: payload });
    return this.serializeReceiving(created);
  }

  async updateReceiving(id: string, data: any) {
    const current = await this.prisma.subcontractReceiving.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('分包领用记录不存在');
    assertVersion(current, data);
    const payload: any = pickFields(data, RECEIVING_FIELDS, { label: '分包领用汇总' });
    if (data?.subcontractorId !== undefined) {
      const sc = data.subcontractorId
        ? await this.prisma.laborAuthLedger.findUnique({ where: { id: data.subcontractorId } })
        : null;
      payload.subcontractorName = sc?.subcontractorName ?? (payload.subcontractorName || '');
    }
    this.applyReceivingDerived(payload);
    payload.version = current.version + 1;
    const updated = await this.prisma.subcontractReceiving.update({ where: { id }, data: payload });
    return this.serializeReceiving(updated);
  }

  async removeReceiving(id: string) {
    await this.prisma.subcontractReceiving.delete({ where: { id } });
    return true;
  }

  private async buildReceivingPayload(data: any, projectId: string) {
    const payload: any = pickFields(data, RECEIVING_FIELDS, { label: '分包领用汇总' });
    payload.projectId = projectId;
    if (data?.subcontractorId) {
      const sc = await this.prisma.laborAuthLedger.findUnique({ where: { id: data.subcontractorId } });
      payload.subcontractorName = sc?.subcontractorName ?? payload.subcontractorName;
    }
    if (!String(payload.subcontractorName || '').trim()) {
      throw new BadRequestException('分包商名称不能为空');
    }
    this.applyReceivingDerived(payload);
    return payload;
  }

  /** 金额派生：qty × unitPrice（两者都有才算；否则 null——"未填"不是 0） */
  private applyReceivingDerived(payload: any) {
    if (payload.qty !== undefined || payload.unitPrice !== undefined) {
      const qty = num(payload.qty);
      const price = num(payload.unitPrice);
      payload.amount = qty != null && price != null ? round(qty * price, 2) : null;
    }
  }

  private serializeReceiving(r: any) {
    return {
      id: r.id,
      subcontractorId: r.subcontractorId,
      subcontractorName: r.subcontractorName,
      period: r.period ?? '',
      materialName: r.materialName ?? '',
      spec: r.spec ?? '',
      unit: r.unit ?? '',
      qty: r.qty == null ? null : Number(r.qty),
      unitPrice: r.unitPrice == null ? null : Number(r.unitPrice),
      amount: r.amount == null ? null : Number(r.amount),
      useLocation: r.useLocation ?? '',
      remark: r.remark ?? '',
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  // ==================== 归档导出（archive.service 调用，按分包商/账期分组） ====================

  /**
   * 分包领用盘点表（某分包单位 + 某账期；periodDir 形如 `2026年10月`）。
   * 按 `subcontractorId`（分包授权台账 ID）过滤——不按名称（改名/重名不失联）；
   * ID 为空的历史行回退按名称（快照）匹配。
   */
  async exportReceivingSheet(projectId: string, subcontractorId: string | null, subcontractorName: string, periodDir: string): Promise<Buffer> {
    const rows = await this.prisma.subcontractReceiving.findMany({
      where: {
        projectId,
        ...(subcontractorId ? { subcontractorId } : { subcontractorName }),
      },
      orderBy: [{ period: 'asc' }, { createdAt: 'asc' }],
    });
    const hit = rows.filter((r) => periodDirOfRows(r.period) === periodDir);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('盘点领用表');
    ws.getRow(1).values = ['序号', '账期', '物资名称', '规格型号', '计量单位', '数量', '单价', '金额', '使用部位', '备注'];
    hit.forEach((r, i) => {
      ws.getRow(i + 2).values = [
        i + 1, r.period ?? '', r.materialName ?? '', r.spec ?? '', r.unit ?? '',
        r.qty == null ? null : Number(r.qty), r.unitPrice == null ? null : Number(r.unitPrice),
        r.amount == null ? null : Number(r.amount), r.useLocation ?? '', r.remark ?? '',
      ];
    });
    ws.columns.forEach((c) => (c.width = 16));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

/** 账期文本 → 目录段（与 archive-naming.periodDirOf 同规则；此处防循环依赖本地实现） */
function periodDirOfRows(period: string | null): string {
  const raw = String(period || '').trim();
  const m = raw.match(/^(\d{4})[.\-/年]\s*(\d{1,2})/);
  return m ? `${m[1]}年${Number(m[2])}月` : raw || '未分账期';
}
