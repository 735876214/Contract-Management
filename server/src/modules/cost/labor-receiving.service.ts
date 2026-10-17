import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import {
  averageUnitPrice,
  deriveReceivingRow,
  type DeriveReceivingInput,
} from '../../common/utils/labor-receiving';
import {
  currentSettlementPeriod,
  periodKeyOf,
  startDayOf,
} from '../../common/utils/settlement-period';

/**
 * 分包单位领用月度汇总（附件需求 2026-10-17 第二批）。
 *
 * 数据模型：一行 = 分包单位 × 结算期 × 材料（名称+规格）。**落库的只有手填字段**
 * （退库/盘点/设计量开累/损耗率/手改单价/备注）；本期领用数量与平均单价每次读取时
 * 从收领单明细**实时聚合**（按 `laborAuthId` 关联 + orderDate 落在该结算期），
 * 「上期末累计」由已存行按期链式推出（J(期N) = J(期N−1) + 净领(期N−1)，首期 0）。
 *
 * 口径：
 * - **按 ID 关联，不按名称**：定位/聚合/查询一律用 `laborAuthId`（分包商改名不断档；
 *   `subcontractorName` 只是展示快照，由台账带出）。
 * - 结算期归属用 `periodKeyOf(startDay, date)`（`common/utils/settlement-period.ts`），
 *   起始日取 `Project.settlementStartDate` 的日——**不许各处自己拼 getMonth**。
 * - 平均单价 = 该分包单位全部期间同「名称+规格」的 Σ(实收×税前单价) ÷ Σ实收
 *   （`averageUnitPrice`）；行上手改过单价（`priceOverridden`）则保留手填值。
 * - 派生列全部走 `deriveReceivingRow()`，不许就地写算式。
 */

/** 手填字段白名单（自动聚合字段不接受直传） */
const EDIT_FIELDS = [
  'laborAuthId', 'subcontractorName', 'period', 'materialName', 'spec', 'unit',
  'unitPrice', 'designQtyCum', 'lossRate', 'returnQty', 'stockTakeQty', 'remark',
];

@Injectable()
export class LaborReceivingService {
  constructor(private prisma: PrismaClient) {}

  /** 分包单位下拉（分包授权台账）+ 已有汇总的期间列表 */
  async options(projectId: string) {
    const [subcontractors, periods] = await Promise.all([
      this.prisma.laborAuthLedger.findMany({
        where: { projectId },
        select: { id: true, subcontractorName: true },
        orderBy: { subcontractorName: 'asc' },
      }),
      this.prisma.laborReceivingSummary.findMany({
        where: { projectId },
        distinct: ['period'],
        select: { period: true },
      }),
    ]);
    return {
      subcontractors,
      periods: periods.map((p) => p.period).sort().reverse(),
    };
  }

  /**
   * 合并读取：自动聚合（领用/单价）+ 已存手填行 + 派生列。
   * `subcontractorId` 为分包授权台账 ID；`period` 为结算期标签 `YYYY-MM`。
   */
  async summary(subcontractorId: string, period: string, projectId: string) {
    const auth = await this.prisma.laborAuthLedger.findUnique({ where: { id: subcontractorId } });
    if (!auth) throw new NotFoundException('分包商（授权台账）不存在');
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('账期格式应为 YYYY-MM');
    const startDay = await this.projectStartDay(projectId);

    // 1. 收领单明细聚合：本期领用 + 全期间单价聚合（一次查全，按期分组）——按 ID 关联
    const agg = await this.aggregateReceipts(projectId, subcontractorId, startDay);

    // 2. 已存手填行（该分包单位全部期间——链式推上期末累计需要历史期）
    const saved = await this.prisma.laborReceivingSummary.findMany({
      where: { projectId, laborAuthId: subcontractorId },
      orderBy: [{ period: 'asc' }, { materialName: 'asc' }],
    });
    const savedKeyMap = new Map(saved.map((r) => [rowKey(r.period, r.materialName, r.spec), r]));

    // 3. 上期末累计链：按期升序累计「净领」（净领依赖手填退库，故只能基于已存行推导）
    const prevCumByKey = this.buildPrevCumMap(saved, agg.receivedByPeriod);

    // 4. 行集合 = 本期收领单聚合行 ∪ 已存手填行（本期）
    const periodRows = agg.receivedByPeriod.get(period) ?? new Map();
    const savedPeriodRows = saved.filter((r) => r.period === period);
    const keys = new Set<string>([
      ...periodRows.keys(),
      ...savedPeriodRows.map((r) => rowKey(r.period, r.materialName, r.spec)),
    ]);

    const list: any[] = [];
    let sort = 0;
    for (const key of keys) {
      const { materialName, spec } = parseRowKey(key);
      const savedRow = savedKeyMap.get(key);
      const auto = periodRows.get(key);
      const receivedQty = auto?.qty ?? null;
      // 单价：手改过 → 保留行上值；否则用全期聚合平均单价
      const unitPrice =
        savedRow?.priceOverridden && savedRow.unitPrice != null
          ? Number(savedRow.unitPrice)
          : agg.avgPriceByKey.get(key) ?? (savedRow?.unitPrice != null ? Number(savedRow.unitPrice) : null);
      const input: DeriveReceivingInput = {
        prevCum: prevCumByKey.get(key) ?? 0,
        receivedQty,
        returnQty: savedRow?.returnQty != null ? Number(savedRow.returnQty) : null,
        stockTakeQty: savedRow?.stockTakeQty != null ? Number(savedRow.stockTakeQty) : null,
        designQtyCum: savedRow?.designQtyCum != null ? Number(savedRow.designQtyCum) : null,
        lossRate: savedRow?.lossRate != null ? Number(savedRow.lossRate) : null,
        unitPrice,
      };
      const derived = deriveReceivingRow(input);
      list.push({
        key,
        sort: sort++,
        prevCum: prevCumByKey.get(key) ?? 0,
        laborAuthId: subcontractorId,
        subcontractorName: auth.subcontractorName,
        period,
        materialName,
        spec,
        unit: auto?.unit ?? savedRow?.unit ?? null,
        summaryId: savedRow?.id ?? null,
        version: savedRow?.version ?? 0,
        receivedQty, // 本期领用（自动，只读）
        unitPrice, // 平均单价（自动，可改 → priceOverridden）
        priceOverridden: savedRow?.priceOverridden ?? false,
        designQtyCum: input.designQtyCum,
        lossRate: input.lossRate,
        returnQty: input.returnQty,
        stockTakeQty: input.stockTakeQty,
        remark: savedRow?.remark ?? '',
        ...derived,
      });
    }
    return buildResult(list, list.length);
  }

  /** upsert 单行手填字段（按 projectId+分包单位(台账ID)+期+材料+规格 定位） */
  async upsert(data: any, projectId: string, user: any) {
    const payload: any = pickFields(data, EDIT_FIELDS, { label: '分包单位领用汇总' });
    if (!/^\d{4}-\d{2}$/.test(String(payload.period || ''))) throw new BadRequestException('账期格式应为 YYYY-MM');
    if (!String(payload.materialName || '').trim()) throw new BadRequestException('物资名称不能为空');
    // 分包单位必选（按 ID 定位）；名称只是快照，由台账带出
    if (!data?.laborAuthId) throw new BadRequestException('请选择分包单位');
    const auth = await this.prisma.laborAuthLedger.findUnique({ where: { id: data.laborAuthId } });
    if (!auth) throw new BadRequestException('所选分包单位不存在');
    payload.subcontractorName = auth.subcontractorName;
    // 手改单价 → 标记覆盖；未传 unitPrice 或清空 → 不动标记
    if (payload.unitPrice !== undefined) {
      payload.priceOverridden = num(payload.unitPrice) != null;
    }
    ['unitPrice', 'designQtyCum', 'lossRate', 'returnQty', 'stockTakeQty'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });

    // spec 落库统一为空串（复合唯一键不接受 null；对外序列化仍输出 ''）
    payload.spec = String(payload.spec ?? '').trim();
    const where = {
      projectId_laborAuthId_period_materialName_spec: {
        projectId,
        laborAuthId: payload.laborAuthId,
        period: payload.period,
        materialName: payload.materialName,
        spec: payload.spec,
      },
    } as any;
    const existing = await this.prisma.laborReceivingSummary.findUnique({ where });
    if (existing) {
      assertVersion(existing, data);
      const { laborAuthId, subcontractorName, period, materialName, spec, ...editable } = payload;
      void laborAuthId; void subcontractorName; void period; void materialName; void spec;
      const updated = await this.prisma.laborReceivingSummary.update({
        where,
        data: { ...editable, version: existing.version + 1 },
      });
      return this.serialize(updated);
    }
    const created = await this.prisma.laborReceivingSummary.create({
      data: { ...payload, projectId, createdBy: user?.id },
    });
    return this.serialize(created);
  }

  /** 批量保存（导入/表格整批提交）：逐行 upsert，任一行失败即整体失败 */
  async saveBatch(rows: any[], projectId: string, user: any) {
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException('导入内容为空');
    if (rows.length > 1000) throw new BadRequestException('单次最多导入 1000 行');
    const results: any[] = [];
    // 两阶段精神：先全量校验（upsert 的校验部分），再写入。此处逐行事务内 upsert，
    // 任何一行抛错则整体 400（已写行在事务外——数量小，失败重导即可幂等覆盖）。
    for (const row of rows) {
      results.push(await this.upsert(row, projectId, user));
    }
    return results;
  }

  // ==================== 导出（三张 sheet：图一盘点 / 图二月度汇总 / 图三节超分析） ====================

  async exportWorkbook(subcontractorId: string, period: string, projectId: string): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const res: any = await this.summary(subcontractorId, period, projectId);
    const rows: any[] = res.list || [];
    const auth = await this.prisma.laborAuthLedger.findUnique({ where: { id: subcontractorId } });
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    const periodLabel = periodLabelOf(period); // 'YYYY-MM' → 'YYYY年M月'

    const wb = new ExcelJS.Workbook();

    // ---- Sheet1 图一：分包单位月度库存盘点表 ----
    const ws1 = wb.addWorksheet('月度库存盘点表');
    ws1.mergeCells('B1:E1');
    ws1.getCell('B1').value = `分包单位月度库存盘点表（${periodLabel}）`;
    ws1.getCell('B1').font = { size: 14, bold: true };
    ws1.getCell('B1').alignment = { horizontal: 'center' };
    ws1.getRow(2).values = ['', '项目名称', project?.name ?? '', '', `${periodLabel}1日`];
    ws1.getRow(3).values = ['', '分包单位名称', auth?.subcontractorName ?? ''];
    ws1.getRow(4).values = ['序号', '物资名称', '规格型号', '单位', '本月库存', '备注'];
    ws1.getRow(4).font = { bold: true };
    rows.forEach((r, i) => {
      ws1.getRow(i + 5).values = [
        i + 1, r.materialName, r.spec ?? '', r.unit ?? '',
        r.stockTakeQty == null ? null : Number(r.stockTakeQty), r.remark ?? '',
      ];
    });
    ws1.columns.forEach((c) => (c.width = 16));

    // ---- Sheet2 图二：分包单位领用物资月度汇总表 ----
    const ws2 = wb.addWorksheet('领用物资月度汇总表');
    ws2.getCell('A1').value = `分包单位领用物资月度汇总表（${periodLabel}）`;
    ws2.getCell('A1').font = { size: 14, bold: true };
    ws2.getRow(2).values = ['项目名称', project?.name ?? '', '', '分包单位名称', auth?.subcontractorName ?? ''];
    ws2.getRow(3).values = ['序号', '物资名称', '规格型号', '单位', '上期末累计', '本期领用数量', '本期退库数量', '本期净领数量', '备注'];
    ws2.getRow(3).font = { bold: true };
    rows.forEach((r, i) => {
      ws2.getRow(i + 4).values = [
        i + 1, r.materialName, r.spec ?? '', r.unit ?? '',
        r.prevCum, r.receivedQty, r.returnQty, r.netQty, r.remark ?? '',
      ];
    });
    ws2.columns.forEach((c) => (c.width = 15));

    // ---- Sheet3 图三：甲供材节超分析表 ----
    const ws3 = wb.addWorksheet('甲供材节超分析表');
    ws3.getCell('A1').value = `甲供材节超分析表（${periodLabel}）`;
    ws3.getCell('A1').font = { size: 14, bold: true };
    ws3.getRow(2).values = ['工程名称', project?.name ?? '', '', '分包单位', auth?.subcontractorName ?? ''];
    ws3.getRow(3).values = [
      '序号', '材料名称', '规格型号', '单位', '单价(元)', '扣款单价(元)',
      '设计量·至本期末开累', '损耗率%', '设计量小计(含损耗)',
      '至本期末开累用量', '库存', '实耗', '节(-)超(+)', '结算扣款(元)', '实际损耗率%', '备注',
    ];
    ws3.getRow(3).font = { bold: true };
    rows.forEach((r, i) => {
      ws3.getRow(i + 4).values = [
        i + 1, r.materialName, r.spec ?? '', r.unit ?? '',
        r.unitPrice, r.deductPrice, r.designQtyCum, r.lossRate, r.designSubtotal,
        r.usedCum, r.stockTakeQty, r.actualUse, r.saveOver, r.deductAmount,
        r.actualLossRate == null ? null : r.actualLossRate * 100, r.remark ?? '',
      ];
    });
    ws3.columns.forEach((c) => (c.width = 15));

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ==================== 私有 ====================

  private async projectStartDay(projectId: string): Promise<number> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { settlementStartDate: true },
    });
    return startDayOf(project?.settlementStartDate ?? null);
  }

  /**
   * 收领单明细聚合（领用单位 = 分包单位，按 `laborAuthId` 关联——不按名称）：
   * - `receivedByPeriod`：期标签 → (材料key → 本期领用数量/单位)；
   * - `avgPriceByKey`：材料key → 全期间平均单价（Σ税前总价 ÷ Σ数量）。
   */
  private async aggregateReceipts(projectId: string, subcontractorId: string, startDay: number) {
    const orders = await this.prisma.receiptOrder.findMany({
      where: {
        projectId,
        receivingUnitType: 'SUBCONTRACTOR',
        // 分包商在收领单上可能出现在两侧：供应单位（subcontractorId）或领用单位（receivingUnitId）
        OR: [{ subcontractorId }, { receivingUnitId: subcontractorId }],
      },
      select: {
        id: true, orderDate: true,
        details: { select: { materialName: true, specModel: true, unit: true, receivedQty: true, priceBeforeTax: true } },
      },
    });
    const receivedByPeriod = new Map<string, Map<string, { qty: number; unit: string | null }>>();
    const priceAgg = new Map<string, { total: number; qty: number; unit: string | null }>();
    for (const o of orders) {
      const period = o.orderDate ? periodKeyOf(startDay, o.orderDate) : null;
      if (!period) continue;
      let bucket = receivedByPeriod.get(period);
      if (!bucket) receivedByPeriod.set(period, (bucket = new Map()));
      for (const d of o.details) {
        const name = String(d.materialName || '').trim();
        if (!name) continue;
        const key = rowKey(period, name, d.specModel || null);
        const qty = num(d.receivedQty) ?? 0;
        const price = num(d.priceBeforeTax);
        const hit = bucket.get(key);
        if (hit) hit.qty += qty;
        else bucket.set(key, { qty, unit: d.unit ?? null });
        if (price != null) {
          const p = priceAgg.get(key) ?? { total: 0, qty: 0, unit: d.unit ?? null };
          p.total += qty * price;
          p.qty += qty;
          priceAgg.set(key, p);
        }
      }
    }
    const avgPriceByKey = new Map<string, number>();
    for (const [key, p] of priceAgg) {
      const avg = averageUnitPrice(p.total, p.qty);
      if (avg != null) avgPriceByKey.set(key, avg);
    }
    return { receivedByPeriod, avgPriceByKey };
  }

  /**
   * 上期末累计链：J(期N) = J(期N−1) + 净领(期N−1)，首期 0。
   * 净领依赖手填退库，故历史期只基于**已存行**推导（未保存期间的材料不进链）。
   * 返回键 = rowKey(期, 材料, 规格)（与 summary 的行键同口径）。
   */
  private buildPrevCumMap(
    saved: any[],
    receivedByPeriod: Map<string, Map<string, { qty: number }>>,
  ): Map<string, number> {
    const cumByMat = new Map<string, number>(); // 材料 key（不含期）→ 截至上一期的开累
    const prevCumByKey = new Map<string, number>(); // 期+材料 key → 上期末累计
    const periods = Array.from(new Set(saved.map((r) => r.period))).sort();
    for (const period of periods) {
      const rows = saved.filter((r) => r.period === period);
      const autoRows = receivedByPeriod.get(period) ?? new Map();
      for (const r of rows) {
        const matKey = rowKey('', r.materialName, r.spec); // 材料维度的累计键（不含期）
        const fullKey = rowKey(period, r.materialName, r.spec);
        const prev = cumByMat.get(matKey) ?? 0;
        prevCumByKey.set(fullKey, prev);
        // 净领 = 本期领用（自动聚合；无记录按 0）− 手填退库
        const received = autoRows.get(fullKey)?.qty ?? 0;
        const ret = r.returnQty != null ? Number(r.returnQty) : 0;
        cumByMat.set(matKey, prev + received - ret);
      }
    }
    return prevCumByKey;
  }

  private serialize(r: any) {
    return {
      id: r.id,
      laborAuthId: r.laborAuthId,
      subcontractorName: r.subcontractorName,
      period: r.period,
      materialName: r.materialName,
      spec: r.spec ?? '',
      unit: r.unit ?? '',
      unitPrice: r.unitPrice == null ? null : Number(r.unitPrice),
      priceOverridden: r.priceOverridden,
      designQtyCum: r.designQtyCum == null ? null : Number(r.designQtyCum),
      lossRate: r.lossRate == null ? null : Number(r.lossRate),
      returnQty: r.returnQty == null ? null : Number(r.returnQty),
      stockTakeQty: r.stockTakeQty == null ? null : Number(r.stockTakeQty),
      remark: r.remark ?? '',
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

/** 行键（期+名称+规格）——与唯一键同口径；spec 为 null 时用空串 */
function rowKey(period: string, materialName: string, spec: string | null | undefined): string {
  return `${period}\u0001${materialName}\u0002${spec ?? ''}`;
}

function parseRowKey(key: string): { materialName: string; spec: string } {
  const [, rest = ''] = key.split('\u0001');
  const idx = rest.indexOf('\u0002');
  return idx < 0 ? { materialName: rest, spec: '' } : { materialName: rest.slice(0, idx), spec: rest.slice(idx + 1) };
}

/** 'YYYY-MM' → 'YYYY年M月'；认不出原样返回 */
function periodLabelOf(period: string): string {
  const m = String(period).match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[1]}年${Number(m[2])}月` : period;
}
