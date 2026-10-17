import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { buildResult, num, paginate, assertVersion } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { weightedUnitPrice } from '../../common/utils/labor-receiving';
import { LaborReceivingService } from './labor-receiving.service';

/**
 * 月度盈亏分析（附件需求 2026-10-17 第三批；替换原手工台账 ProfitLossAnalysis）。
 *
 * **一个月一条记录**：新建时把当期各分包单位「甲供材节超分析」行**快照**成明细行
 * （单价/数量冻结，历史表样不随后续改单变化）；责任人/劳务计价已扣/备注及各数量列可手改；
 * 「重新抓取」重算快照并按 laborAuthId+材料+规格 回填手填项。
 * 汇总表不落库——导出时由明细行按材料**跨队加权汇总**（`weightedUnitPrice`）。
 */

const HEADER_FIELDS = ['period', 'sixSavingsAmount', 'totalDeductAmount', 'remark'];
const DETAIL_EDITABLE = [
  'owner', 'unitPrice', 'entryQty', 'designQty', 'lossRate', 'theoryUseQty',
  'actualUseQty', 'stockQty', 'saveOverQty', 'deductAmount', 'remark',
];

@Injectable()
export class MonthlyProfitLossService {
  constructor(
    private prisma: PrismaClient,
    private laborReceiving: LaborReceivingService,
  ) {}

  async list(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.period) where.period = query.period;
    const [rows, total] = await Promise.all([
      this.prisma.monthlyProfitLoss.findMany({
        where, skip, take,
        orderBy: { period: 'desc' },
        include: { _count: { select: { details: true } } },
      }),
      this.prisma.monthlyProfitLoss.count({ where }),
    ]);
    return buildResult(
      rows.map((r) => this.serializeHeader(r, (r as any)._count?.details ?? 0)),
      total,
      query,
    );
  }

  async detail(id: string) {
    const r = await this.prisma.monthlyProfitLoss.findUnique({
      where: { id },
      include: { details: { orderBy: [{ laborTeamName: 'asc' }, { sortOrder: 'asc' }] } },
    });
    if (!r) throw new NotFoundException('月度盈亏分析记录不存在');
    return { ...this.serializeHeader(r), details: r.details.map((d) => this.serializeDetail(d)) };
  }

  /** 新建：校验期唯一 → 生成当期快照明细 */
  async create(data: any, projectId: string, user: any) {
    const period = String(data?.period || '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('请选择结算期（YYYY-MM）');
    const dup = await this.prisma.monthlyProfitLoss.findUnique({
      where: { projectId_period: { projectId, period } },
    });
    if (dup) throw new BadRequestException(`该结算期（${period}）已有盈亏分析记录`);
    const payload: any = pickFields({ ...data, period }, HEADER_FIELDS, { label: '月度盈亏分析' });
    payload.projectId = projectId;
    payload.createdBy = user?.id;
    ['sixSavingsAmount', 'totalDeductAmount'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    const created = await this.prisma.monthlyProfitLoss.create({ data: payload });
    await this.snapshotDetails(created.id, projectId, period);
    return this.detail(created.id);
  }

  /** 更新：头字段 + 明细行手改（按明细 ID 逐行，乐观锁在头记录上） */
  async update(id: string, data: any) {
    const current = await this.prisma.monthlyProfitLoss.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('月度盈亏分析记录不存在');
    assertVersion(current, data);
    const payload: any = pickFields(data, HEADER_FIELDS.filter((f) => f !== 'period'), { label: '月度盈亏分析' });
    ['sixSavingsAmount', 'totalDeductAmount'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    payload.version = current.version + 1;
    await this.prisma.monthlyProfitLoss.update({ where: { id }, data: payload });
    // 明细手改
    if (Array.isArray(data?.details)) {
      for (const d of data.details) {
        if (!d?.id) continue;
        const row = pickFields(d, DETAIL_EDITABLE, { label: '盈亏明细行' });
        (['unitPrice', 'entryQty', 'designQty', 'lossRate', 'theoryUseQty', 'actualUseQty', 'stockQty', 'saveOverQty', 'deductAmount'] as const).forEach((f) => {
          if (row[f] !== undefined) row[f] = num(row[f]);
        });
        // 盈亏金额联动（未被显式改写时）：盈亏数量 × 单价
        await this.recalcDetailAmount(d.id, row);
      }
    }
    return this.detail(id);
  }

  async remove(id: string) {
    await this.prisma.monthlyProfitLoss.delete({ where: { id } });
    return true;
  }

  /** 重新抓取：删明细重生成快照，按 laborAuthId+材料+规格 回填手填项 */
  async reSnapshot(id: string) {
    const current = await this.prisma.monthlyProfitLoss.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('月度盈亏分析记录不存在');
    const old = await this.prisma.monthlyProfitLossDetail.findMany({ where: { profitLossId: id } });
    const manual = new Map(old.map((d) => [`${d.laborAuthId ?? ''}\u0001${d.materialName}\u0002${d.spec ?? ''}`, d]));
    await this.prisma.monthlyProfitLossDetail.deleteMany({ where: { profitLossId: id } });
    await this.snapshotDetails(id, current.projectId, current.period, manual);
    return this.detail(id);
  }

  // ==================== 导出（封面 + 明细 + 汇总三 sheet） ====================

  async exportWorkbook(id: string, projectId: string): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const { CSCEC_LOGO_PNG_BASE64 } = await import('../../common/services/cscec-logo.base64');
    const full: any = await this.detail(id);
    const details: any[] = full.details || [];
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    const periodLabel = periodLabelOf(full.period);

    const wb = new ExcelJS.Workbook();

    // ---- Sheet1 封面 ----
    const cover = wb.addWorksheet('封面');
    cover.columns = [{ width: 60 }];
    const coverLines: Array<[string, number, boolean]> = [
      ['中国建筑土木建设有限公司', 20, true],
      ['华北公司', 18, true],
      ['', 12, false],
      [project?.name ?? '', 16, true],
      ['', 12, false],
      ['', 12, false],
      ['', 12, false],
      ['', 12, false],
      ['', 12, false],
      ['', 12, false],
      ['', 12, false],
      ['', 12, false],
      ['降本、创效、主材盈亏分析', 18, true],
      [periodLabel, 14, true],
      ['物资部负责人：', 12, false],
    ];
    coverLines.forEach(([text, size, bold], i) => {
      const cell = cover.getCell(i + 1, 1);
      cell.value = text;
      cell.font = { size, bold, name: '楷体' };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cover.getRow(i + 1).height = size + 14;
    });
    try {
      const logoId = wb.addImage({ base64: CSCEC_LOGO_PNG_BASE64, extension: 'png' });
      cover.addImage(logoId, { tl: { col: 0.4, row: 5.5 }, ext: { width: 140, height: 140 } });
    } catch {
      // logo 缺失不阻断导出
    }

    // ---- Sheet2 明细表（图2）----
    const ws2 = wb.addWorksheet('明细表');
    ws2.getCell('A1').value = `${project?.name ?? ''}项目降本、创效、主材盈亏分析汇总表（开工至${periodLabel}1日）`;
    ws2.getCell('A1').font = { size: 14, bold: true };
    ws2.getRow(2).values = ['项目名称', project?.name ?? ''];
    const HEAD = [
      '序号', '材料名称', '规格型号', '单位', '单价', '进场量-数量', '进场量-金额',
      '图纸设计量-数量', '图纸设计量-金额', '损耗率', '理论消耗量-数量', '理论消耗量-金额',
      '实际消耗量-数量', '实际消耗量-金额', '库存量-数量', '库存量-金额',
      '盈(+)/亏(-)-数量', '盈(+)/亏(-)-金额', '节超率', '劳务队名称', '责任人', '劳务计价已扣', '备注',
    ];
    ws2.getRow(3).values = HEAD;
    ws2.getRow(3).font = { bold: true };
    ws2.getRow(3).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    ws2.getRow(3).height = 30;
    let r2 = 4;
    let seq = 1;
    let team = '';
    for (const d of details) {
      if (team && team !== d.laborTeamName) {
        // 组尾「劳务计价已扣」小计行
        const teamDeduct = details
          .filter((x) => x.laborTeamName === team)
          .reduce((s, x) => s + (x.deductAmount ?? 0), 0);
        ws2.getRow(r2).values = [`劳务计价已扣（${team}）`, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', round2(teamDeduct)];
        ws2.getRow(r2).font = { bold: true };
        r2 += 1;
      }
      team = d.laborTeamName;
      const price = d.unitPrice;
      ws2.getRow(r2).values = [
        seq++,
        d.materialName, d.spec ?? '', d.unit ?? '', price,
        d.entryQty, amountOf(d.entryQty, price),
        d.designQty, amountOf(d.designQty, price),
        d.lossRate == null ? null : Number(d.lossRate),
        d.theoryUseQty, amountOf(d.theoryUseQty, price),
        d.actualUseQty, amountOf(d.actualUseQty, price),
        d.stockQty, amountOf(d.stockQty, price),
        d.saveOverQty, d.saveOverAmount ?? amountOf(d.saveOverQty, price),
        d.saveRate == null ? null : Number(d.saveRate),
        d.laborTeamName, d.owner ?? '', d.deductAmount, d.remark ?? '',
      ];
      r2 += 1;
    }
    ws2.columns.forEach((c) => (c.width = 13));

    // ---- Sheet3 汇总表（图1）：按材料跨队加权汇总 ----
    const ws3 = wb.addWorksheet('汇总表');
    ws3.getCell('A1').value = `${project?.name ?? ''}项目降本、创效、主材盈亏分析汇总表（开工至${periodLabel}1日）`;
    ws3.getCell('A1').font = { size: 14, bold: true };
    ws3.getRow(2).values = ['项目名称', project?.name ?? ''];
    ws3.getRow(3).values = [
      '序号', '材料名称', '单位', '单价', '进场量-数量', '进场量-金额',
      '理论消耗量-数量', '理论消耗量-金额', '实际消耗量-数量', '实际消耗量-金额',
      '库存量-数量', '库存量-金额', '盈(+)/亏(-)-数量', '盈(+)/亏(-)-金额', '节超率', '备注',
    ];
    ws3.getRow(3).font = { bold: true };
    ws3.getRow(3).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    // 按材料名称+规格合并（跨劳务队）
    const byMat = new Map<string, any[]>();
    for (const d of details) {
      const key = `${d.materialName}\u0001${d.spec ?? ''}`;
      if (!byMat.has(key)) byMat.set(key, []);
      byMat.get(key)!.push(d);
    }
    let r3 = 4;
    let seq3 = 1;
    const allSums = { theory: 0, actual: 0, stock: 0 };
    for (const [, list] of byMat) {
      const sum = (f: string) => list.reduce((s, x) => s + (Number(x[f]) || 0), 0);
      const nullableSum = (f: string) =>
        list.every((x) => x[f] == null) ? null : sum(f);
      const qty = nullableSum('entryQty');
      const theory = nullableSum('theoryUseQty');
      const actual = nullableSum('actualUseQty');
      const stock = nullableSum('stockQty');
      const saveOver = nullableSum('saveOverQty');
      // 加权单价：每行取第一个非零的数量口径（进场量 → 理论消耗 → 实际消耗）作权重
      const pickQty = (x: any) => {
        for (const f of ['entryQty', 'theoryUseQty', 'actualUseQty']) {
          const v = Number(x[f]);
          if (Number.isFinite(v) && v !== 0) return v;
        }
        const v = Number(x.entryQty);
        return Number.isFinite(v) ? v : null;
      };
      const price = weightedUnitPrice(list.map((x) => ({ qty: pickQty(x), unitPrice: x.unitPrice })));
      const first = list[0];
      if (theory != null) allSums.theory += theory;
      if (actual != null) allSums.actual += actual;
      if (stock != null) allSums.stock += stock;
      ws3.getRow(r3).values = [
        seq3++, first.materialName, first.unit ?? '', price,
        qty, amountOf(qty, price),
        theory, amountOf(theory, price),
        actual, amountOf(actual, price),
        stock, amountOf(stock, price),
        saveOver, amountOf(saveOver, price),
        saveOver != null && theory ? round2(saveOver / theory) : null,
        list.map((x) => x.remark).filter(Boolean).join('；'),
      ];
      r3 += 1;
    }
    // 尾部合计行
    const six = full.sixSavingsAmount;
    const totalDeduct = full.totalDeductAmount;
    ws3.getRow(r3).values = ['六项降本创效金额', '', '', '', '', '', '', '', '', '', '', '', '', round2(Number(six) || 0), '', '资产降本'];
    ws3.getRow(r3).font = { bold: true };
    ws3.getRow(r3 + 1).values = ['劳务计价累计扣款金额', '元', '', '', '', '', '', '', '', '', '', '', '', round2(Number(totalDeduct) || 0), '', ''];
    ws3.getRow(r3 + 1).font = { bold: true };
    ws3.getRow(r3 + 2).values = ['非自拌混凝土原材合计', '', '', '', '', '', '', '', round2(allSums.actual), '', '', '', '', '', '', ''];
    ws3.getRow(r3 + 2).font = { bold: true };
    ws3.getRow(r3 + 4).values = ['进场量/实际库存量/实际消耗量统计截止至' + periodLabel + '1日 11:00'];
    ws3.getRow(r3 + 6).values = ['制表人：', '', '物资部经理：', '', '工程部经理：', '', '合约部经理：', '', '商务经理：', '', '项目经理：'];
    ws3.columns.forEach((c) => (c.width = 14));

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ==================== 私有 ====================

  /** 生成快照明细（manual 传入时按 手填 项回填） */
  private async snapshotDetails(
    profitLossId: string,
    projectId: string,
    period: string,
    manual?: Map<string, any>,
  ) {
    const auths = await this.prisma.laborAuthLedger.findMany({
      where: { projectId },
      select: { id: true, subcontractorName: true },
      orderBy: { subcontractorName: 'asc' },
    });
    const rows: any[] = [];
    let sort = 0;
    for (const auth of auths) {
      const snapshot = await this.laborReceiving.periodSnapshotRows(auth.id, period, projectId);
      for (const s of snapshot) {
        const key = `${auth.id}\u0001${s.materialName}\u0002${s.spec ?? ''}`;
        const m = manual?.get(key);
        const saveOverQty = s.saveOverQty;
        const saveOverAmount =
          m?.saveOverAmount !== undefined && m?.saveOverAmount !== null
            ? num(m.saveOverAmount)
            : amountOf(saveOverQty, s.unitPrice);
        rows.push({
          profitLossId,
          sortOrder: sort++,
          laborAuthId: auth.id,
          laborTeamName: auth.subcontractorName,
          owner: m?.owner ?? null,
          materialName: s.materialName,
          spec: s.spec || null,
          unit: s.unit,
          unitPrice: s.unitPrice,
          entryQty: s.entryQty,
          designQty: s.designQty,
          lossRate: s.lossRate,
          theoryUseQty: s.theoryUseQty,
          actualUseQty: s.actualUseQty,
          stockQty: s.stockQty,
          saveOverQty,
          saveOverAmount,
          saveRate: saveOverQty != null && s.theoryUseQty ? round2(saveOverQty / s.theoryUseQty) : null,
          deductAmount: m?.deductAmount ?? null,
          remark: m?.remark ?? s.remark ?? '',
        });
      }
    }
    if (rows.length) await this.prisma.monthlyProfitLossDetail.createMany({ data: rows });
    return rows.length;
  }

  /** 明细行手改后联动盈亏金额（显式传了 saveOverAmount 则以手填为准） */
  private async recalcDetailAmount(detailId: string, row: any) {
    const data: any = { ...row };
    if (row.saveOverAmount === undefined) {
      const cur = await this.prisma.monthlyProfitLossDetail.findUnique({ where: { id: detailId } });
      if (cur) {
        const qty = row.saveOverQty !== undefined ? num(row.saveOverQty) : (cur.saveOverQty != null ? Number(cur.saveOverQty) : null);
        const price = row.unitPrice !== undefined ? num(row.unitPrice) : (cur.unitPrice != null ? Number(cur.unitPrice) : null);
        data.saveOverAmount = qty != null ? amountOf(qty, price) : null;
        // 节超率联动
        const theory = row.theoryUseQty !== undefined ? num(row.theoryUseQty) : (cur.theoryUseQty != null ? Number(cur.theoryUseQty) : null);
        data.saveRate = qty != null && theory ? round2(qty / theory) : null;
      }
    }
    await this.prisma.monthlyProfitLossDetail.update({ where: { id: detailId }, data });
  }

  private serializeHeader(r: any, detailCount?: number) {
    return {
      id: r.id,
      period: r.period,
      sixSavingsAmount: r.sixSavingsAmount == null ? null : Number(r.sixSavingsAmount),
      totalDeductAmount: r.totalDeductAmount == null ? null : Number(r.totalDeductAmount),
      remark: r.remark ?? '',
      detailCount: detailCount ?? r._count?.details ?? undefined,
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private serializeDetail(d: any) {
    return {
      id: d.id,
      sortOrder: d.sortOrder,
      laborAuthId: d.laborAuthId,
      laborTeamName: d.laborTeamName,
      owner: d.owner ?? '',
      materialName: d.materialName,
      spec: d.spec ?? '',
      unit: d.unit ?? '',
      unitPrice: d.unitPrice == null ? null : Number(d.unitPrice),
      entryQty: d.entryQty == null ? null : Number(d.entryQty),
      designQty: d.designQty == null ? null : Number(d.designQty),
      lossRate: d.lossRate == null ? null : Number(d.lossRate),
      theoryUseQty: d.theoryUseQty == null ? null : Number(d.theoryUseQty),
      actualUseQty: d.actualUseQty == null ? null : Number(d.actualUseQty),
      stockQty: d.stockQty == null ? null : Number(d.stockQty),
      saveOverQty: d.saveOverQty == null ? null : Number(d.saveOverQty),
      saveOverAmount: d.saveOverAmount == null ? null : Number(d.saveOverAmount),
      saveRate: d.saveRate == null ? null : Number(d.saveRate),
      deductAmount: d.deductAmount == null ? null : Number(d.deductAmount),
      remark: d.remark ?? '',
    };
  }
}

/** 盈亏金额 = 数量 × 单价（单价未知 → null；数量未知/0 → 0） */
function amountOf(qty: unknown, price: unknown): number | null {
  const q = Number(qty);
  if (!Number.isFinite(q)) return null;
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return round2(q * p);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 'YYYY-MM' → 'YYYY年M月'；认不出原样返回 */
function periodLabelOf(period: string): string {
  const m = String(period).match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[1]}年${Number(m[2])}月` : period;
}
