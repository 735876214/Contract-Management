import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import {
  averageUnitPrice,
  deriveReceivingRow,
  type DeriveReceivingInput,
} from '../../common/utils/labor-receiving';
import { periodKeyOf, startDayOf } from '../../common/utils/settlement-period';

/**
 * 分包单位领用**单据**（附件需求 2026-10-17 第二批单据化；一单 = 分包单位 × 结算期）。
 *
 * - 头表 `LaborReceivingDoc`（docNo 自动生成、劳务合同名称、状态）；明细行 `LaborReceivingSummary`
 *   挂 `docId`（落库的只有手填字段：退库/盘点/设计量开累/损耗率/手改单价/备注）。
 * - **本期领用数量与平均单价每次读取时从收领单明细实时聚合**（按 `laborAuthId` 关联 +
 *   orderDate 落在该结算期），「上期末累计」按期链式推出（首期 0）——与单据化前口径一致。
 * - 派生列全部走 `deriveReceivingRow()`，不许就地写算式。
 */

/** 明细行可写字段（自动聚合字段不接受直传） */
const DETAIL_FIELDS = [
  'materialName', 'spec', 'unit',
  'unitPrice', 'designQtyCum', 'lossRate', 'returnQty', 'stockTakeQty', 'remark',
];

@Injectable()
export class LaborReceivingService {
  constructor(private prisma: PrismaClient) {}

  /** 分包单位下拉（分包授权台账） */
  async options(projectId: string) {
    const subcontractors = await this.prisma.laborAuthLedger.findMany({
      where: { projectId },
      select: { id: true, subcontractorName: true },
      orderBy: { subcontractorName: 'asc' },
    });
    return { subcontractors };
  }

  // ==================== 单据 ====================

  /** 单据列表（keyword：单号/分包商/合同名；period 过滤；updatedAt 倒序） */
  async listDocs(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.period) where.period = query.period;
    if (query.status) where.status = query.status;
    if (query.keyword) {
      where.OR = [
        { docNo: { contains: query.keyword } },
        { subcontractorName: { contains: query.keyword } },
        { contractName: { contains: query.keyword } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.laborReceivingDoc.findMany({
        where, skip, take,
        orderBy: { updatedAt: 'desc' },
        include: { _count: { select: { details: true } } },
      }),
      this.prisma.laborReceivingDoc.count({ where }),
    ]);
    return buildResult(
      rows.map((r) => this.serializeDoc(r, (r as any)._count?.details ?? 0)),
      total,
      query,
    );
  }

  /** 新建单据：校验台账存在 + 同分包单位同期防重；docNo 自动生成 */
  async createDoc(data: any, projectId: string, user: any) {
    const laborAuthId = String(data?.laborAuthId || '');
    const period = String(data?.period || '').trim();
    if (!laborAuthId) throw new BadRequestException('请选择分包单位');
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('请选择结算期（YYYY-MM）');
    const auth = await this.prisma.laborAuthLedger.findUnique({ where: { id: laborAuthId } });
    if (!auth || auth.projectId !== projectId) throw new BadRequestException('所选分包单位不存在');
    const dup = await this.prisma.laborReceivingDoc.findUnique({
      where: { projectId_laborAuthId_period: { projectId, laborAuthId, period } },
    });
    if (dup) throw new BadRequestException(`该分包单位 ${period} 期已有领用单据（${dup.docNo}）`);
    // 并发下两人同时开单会拿到同一流水号：靠 @@unique([projectId, docNo]) 挡下后重取号
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const docNo = await this.nextDocNo(projectId, period);
      try {
        const created = await this.prisma.laborReceivingDoc.create({
          data: {
            projectId,
            docNo,
            laborAuthId,
            subcontractorName: auth.subcontractorName,
            period,
            contractName: String(data?.contractName || '').trim() || null,
            createdBy: user?.id,
          },
        });
        return this.serializeDoc(created);
      } catch (e: any) {
        if (e?.code !== 'P2002' || attempt === 2) throw e;
      }
    }
    throw new BadRequestException('单据编号生成失败，请稍后重试');
  }

  /**
   * 归属复核（防御纵深）：按 id 直读/改写时必须确认单据属于请求头项目，
   * 否则任何持 cost:view / cost:edit 的用户带上自己项目的 header 就能操作别人的单据。
   */
  private assertDocInProject<T extends { projectId: string }>(doc: T | null, projectId?: string): T {
    if (!doc) throw new NotFoundException('领用单据不存在');
    if (projectId && doc.projectId !== projectId) throw new NotFoundException('领用单据不存在');
    return doc;
  }

  /** 单据详情：头 + 明细（含收领单自动聚合列与派生列） */
  async docDetail(id: string, projectId?: string) {
    const doc = this.assertDocInProject(
      await this.prisma.laborReceivingDoc.findUnique({ where: { id } }),
      projectId,
    );
    const rows = await this.mergeDocRows(doc);
    return { ...this.serializeDoc(doc), details: rows };
  }

  /** 更新单据：头字段 + 明细批量 upsert（乐观锁在头记录上） */
  async updateDoc(id: string, data: any, projectId?: string) {
    const doc = this.assertDocInProject(
      await this.prisma.laborReceivingDoc.findUnique({ where: { id } }),
      projectId,
    );
    assertVersion(doc, data);
    const payload: any = pickFields(data, ['contractName', 'status', 'remark'], { label: '领用单据' });
    if (payload.contractName !== undefined) {
      payload.contractName = String(payload.contractName || '').trim() || null;
    }
    payload.version = doc.version + 1;
    /**
     * 头 + 明细同一事务（第 6 轮审计）：原来是「先更新头（version 已 +1）再逐行 upsert」，
     * 中途失败会留下「头改了、明细只写一半」，而 version 已经推进 → 用户重试直接 409，
     * 只能手工修数据。
     */
    await this.prisma.$transaction(async (tx) => {
      await tx.laborReceivingDoc.update({ where: { id }, data: payload });
      if (Array.isArray(data?.details)) {
        if (data.details.length > 500) throw new BadRequestException('单次最多保存 500 行明细');
        for (const d of data.details) {
          await this.upsertDetail(doc, d, tx);
        }
      }
    }, { timeout: 60000 });
    return this.docDetail(id, projectId);
  }

  async removeDoc(id: string, projectId?: string) {
    this.assertDocInProject(await this.prisma.laborReceivingDoc.findUnique({ where: { id } }), projectId);
    await this.prisma.laborReceivingDoc.delete({ where: { id } });
    return true;
  }

  /** 明细行 upsert（按 docId+材料+规格 定位；spec 空串与唯一键同口径） */
  private async upsertDetail(
    doc: { id: string; projectId: string; laborAuthId: string; subcontractorName: string; period: string },
    d: any,
    /** 事务客户端：与头记录更新同生共死 */
    db: any = this.prisma,
  ) {
    if (!String(d?.materialName || '').trim()) throw new BadRequestException('物资名称不能为空');
    const row: any = pickFields(d, DETAIL_FIELDS, { label: '领用明细行' });
    row.spec = String(row.spec ?? '').trim();
    ['unitPrice', 'designQtyCum', 'lossRate', 'returnQty', 'stockTakeQty'].forEach((f) => {
      if (row[f] !== undefined) row[f] = num(row[f]);
    });
    if (row.unitPrice !== undefined) row.priceOverridden = num(row.unitPrice) != null;
    const where = {
      docId_materialName_spec: { docId: doc.id, materialName: row.materialName, spec: row.spec },
    } as any;
    const existing = await db.laborReceivingSummary.findUnique({ where });
    if (existing) {
      if (d?.version != null) assertVersion(existing, d);
      const { materialName, spec, ...editable } = row;
      void materialName; void spec;
      await db.laborReceivingSummary.update({
        where,
        data: { ...editable, version: existing.version + 1 },
      });
    } else {
      await db.laborReceivingSummary.create({
        data: {
          ...row,
          docId: doc.id,
          projectId: doc.projectId,
          laborAuthId: doc.laborAuthId,
          subcontractorName: doc.subcontractorName,
          period: doc.period,
          createdBy: undefined,
        },
      });
    }
  }

  /**
   * 单据编号：LRD-YYYYMM-4 位流水（按项目+月份取 max+1）。
   * 按字符串倒序取 max 只在定长序号成立，流水破 9999 后 5 位编号会排到 4 位前面，
   * 于是反复分配到已达上限的号 → 这里取回全部同前缀编号、按数值取 max。
   */
  private async nextDocNo(projectId: string, period: string): Promise<string> {
    const ym = period.replace('-', '');
    const prefix = `LRD-${ym}-`;
    const rows = await this.prisma.laborReceivingDoc.findMany({
      where: { projectId, docNo: { startsWith: prefix } },
      select: { docNo: true },
    });
    const seq =
      rows.reduce((max, r) => {
        const n = parseInt(String(r.docNo).slice(prefix.length), 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0) + 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  /**
   * 合并读取单据明细：已存行 + 收领单自动聚合（本期领用/单价）+ 派生列。
   * 聚合与「上期末累计」链与单据化前完全同口径。
   */
  private async mergeDocRows(doc: {
    id: string; projectId: string; laborAuthId: string; period: string;
  }) {
    const startDay = await this.projectStartDay(doc.projectId);
    const agg = await this.aggregateReceipts(doc.projectId, doc.laborAuthId, startDay);
    const saved = await this.prisma.laborReceivingSummary.findMany({
      where: { docId: doc.id },
      orderBy: [{ materialName: 'asc' }, { spec: 'asc' }],
    });
    // 上期末累计链需要**该分包单位全部期间**的已存行（含其他单据的）
    const history = await this.prisma.laborReceivingSummary.findMany({
      where: { projectId: doc.projectId, laborAuthId: doc.laborAuthId },
      orderBy: [{ period: 'asc' }, { materialName: 'asc' }],
    });
    return this.buildRows(doc.period, saved, agg, history);
  }

  /**
   * 由已取好的聚合/历史数据算某一期的行（`mergeDocRows` 的内核）。
   *
   * 抽出来是为了「导出时把以前各期扣款累加」只查一次库：
   * 逐期调 `mergeDocRows` 会让每期都重跑 `aggregateReceipts` 与历史查询，
   * 导出第 N 期就多付 N 次全量扫表（导出/归档开销随期数平方增长）。
   */
  private buildRows(period: string, saved: any[], agg: any, allHistory: any[]): any[] {
    // `buildPrevCumMap` 内部只取 < period 的期，故这里传全量历史即可
    const history = allHistory.filter((r) => String(r.period) < period);
    const prevCumByMat = this.buildPrevCumMap(history, agg.receivedByPeriod, period);
    const periodRows = agg.receivedByPeriod.get(period) ?? new Map();
    const savedKeys = new Set(saved.map((r) => rowKey(r.materialName, r.spec)));
    const keys = new Set<string>([...periodRows.keys(), ...savedKeys]);
    const list: any[] = [];
    let sort = 0;
    for (const key of keys) {
      const { materialName, spec } = parseRowKey(key);
      const savedRow = saved.find((r) => rowKey(r.materialName, r.spec) === key);
      const auto = periodRows.get(key);
      const receivedQty = auto?.qty ?? null;
      const unitPrice =
        savedRow?.priceOverridden && savedRow.unitPrice != null
          ? Number(savedRow.unitPrice)
          : agg.avgPriceByKey.get(key) ?? (savedRow?.unitPrice != null ? Number(savedRow.unitPrice) : null);
      const input: DeriveReceivingInput = {
        prevCum: prevCumByMat.get(key) ?? 0,
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
        id: savedRow?.id ?? null,
        version: savedRow?.version ?? 0,
        prevCum: prevCumByMat.get(key) ?? 0,
        materialName,
        spec,
        unit: auto?.unit ?? savedRow?.unit ?? null,
        receivedQty, // 本期领用（自动，只读）
        unitPrice,
        priceOverridden: savedRow?.priceOverridden ?? false,
        designQtyCum: input.designQtyCum,
        lossRate: input.lossRate,
        returnQty: input.returnQty,
        stockTakeQty: input.stockTakeQty,
        remark: savedRow?.remark ?? '',
        ...derived,
      });
    }
    return list;
  }

  // ==================== 导出（三张 sheet：盘点 / 月度汇总 / 节超分析，按表样） ====================

  async exportWorkbook(docId: string, projectId?: string): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const doc: any = this.assertDocInProject(
      await this.prisma.laborReceivingDoc.findUnique({
        where: { id: docId },
        include: { laborAuth: { select: { idCardFront: true, signatureScreenshot: true } } },
      }),
      projectId,
    );
    const rows: any[] = await this.mergeDocRows(doc);
    const project = await this.prisma.project.findUnique({ where: { id: doc.projectId } });
    const periodLabel = periodLabelOf(doc.period);

    const wb = new ExcelJS.Workbook();

    // ---- Sheet1 图四：劳务队月度库存盘点表 ----
    const ws1 = wb.addWorksheet('月度库存盘点表');
    ws1.mergeCells('A1:D1');
    ws1.getCell('A1').value = '中国建筑项目管理表格';
    ws1.getCell('A1').font = { size: 16, bold: true };
    ws1.getCell('A1').alignment = { horizontal: 'center' };
    ws1.mergeCells('A2:D2');
    ws1.getCell('A2').value = '劳务队月度库存盘点表';
    ws1.getCell('A2').font = { size: 14, bold: true };
    ws1.getCell('A2').alignment = { horizontal: 'center' };
    ws1.getCell('E2').value = '表格编号';
    ws1.getCell('F2').value = 'CSCEC-SW-B40807';
    ws1.getRow(3).values = ['项目名称', project?.name ?? '', `${periodLabel}1日11时`];
    ws1.getRow(4).values = ['劳务队名称', doc.subcontractorName];
    ws1.getRow(5).values = ['序号', '物资名称', '规格型号', '单位', '本月库存', '备注'];
    ws1.getRow(5).font = { bold: true };
    rows.forEach((r, i) => {
      ws1.getRow(i + 6).values = [
        i + 1, r.materialName, r.spec ?? '', r.unit ?? '',
        r.stockTakeQty == null ? null : Number(r.stockTakeQty), r.remark ?? '',
      ];
    });
    let foot1 = rows.length + 7;
    ws1.getRow(foot1).values = ['分包商材料员：', '', '', '', '', '日期：'];
    ws1.getRow(foot1 + 2).values = ['项目盘点小组成员：', '', '', '', '', '日期：'];
    ws1.columns.forEach((c) => (c.width = 16));

    // ---- Sheet2 图二：劳务队领用物资月度汇总表 ----
    const ws2 = wb.addWorksheet('领用物资月度汇总表');
    ws2.mergeCells('A1:F1');
    ws2.getCell('A1').value = '中国建筑 项目管理表格';
    ws2.getCell('A1').font = { size: 16, bold: true };
    ws2.getCell('A1').alignment = { horizontal: 'center' };
    ws2.mergeCells('A2:F2');
    ws2.getCell('A2').value = '劳务队领用物资月度汇总表';
    ws2.getCell('A2').font = { size: 14, bold: true };
    ws2.getCell('A2').alignment = { horizontal: 'center' };
    ws2.getCell('G2').value = '表格编号';
    ws2.getCell('H2').value = 'CSCEC-SW-B40805';
    ws2.getRow(3).values = ['项目名称', project?.name ?? '', '', `${periodLabel}`, '', ''];
    ws2.getRow(4).values = ['劳务队名称', doc.subcontractorName, '', '劳务合同名称', doc.contractName ?? '', ''];
    ws2.getRow(5).values = ['序号', '物资名称', '规格型号', '单位', '上期末累计-数量', '本期领用数量', '本期退库数量', '净领数量', '备注'];
    ws2.getRow(5).font = { bold: true };
    rows.forEach((r, i) => {
      ws2.getRow(i + 6).values = [
        i + 1, r.materialName, r.spec ?? '', r.unit ?? '',
        r.prevCum, r.receivedQty, r.returnQty, r.netQty, r.remark ?? '',
      ];
    });
    let foot2 = rows.length + 7;
    ws2.getRow(foot2).values = ['合计'];
    ws2.getRow(foot2 + 2).values = [
      `以上数据为分包商 ${doc.subcontractorName} 在 ${periodLabel} 期间与本项目部发生的所有领用业务。`,
    ];
    ws2.getRow(foot2 + 4).values = ['分包商名称（盖章）', '', '项目部级', '', '审签栏', '日期'];
    ws2.getRow(foot2 + 5).values = ['', '', '', '材料工程师', '', ''];
    ws2.getRow(foot2 + 6).values = ['', '', '', '物资部经理', '', ''];
    ws2.getRow(foot2 + 7).values = ['', '', '', '商务经理', '', ''];
    ws2.getRow(foot2 + 8).values = ['分包商核权材料员：', '', '', '项目经理', '', ''];
    ws2.getRow(foot2 + 9).values = ['日期', '', '', '', '', ''];
    ws2.columns.forEach((c) => (c.width = 15));

    // ---- Sheet3 图三：甲方供应材料节超统计表 ----
    const ws3 = wb.addWorksheet('甲供材节超分析表');
    ws3.getCell('A1').value = '甲方供应材料节超统计表';
    ws3.getCell('A1').font = { size: 16, bold: true };
    ws3.getCell('A1').alignment = { horizontal: 'center' };
    ws3.getRow(2).values = [`日期：${periodLabel}1日`];
    ws3.getRow(3).values = ['工程名称', project?.name ?? '', '', '合同编号', doc.contractName ?? ''];
    ws3.getRow(4).values = ['劳务单位', doc.subcontractorName];
    ws3.getRow(5).values = [
      '序号', '材料名称', '规格型号', '单位', '单价(元)', '扣款单价(元)',
      '设计量-至本期末开累', '损耗率%', '小计(含损耗)',
      '至本期末开累用量', '库存', '实耗', '节(-)超(+)量', '结算扣款(元)', '实际损耗率%', '备注',
    ];
    ws3.getRow(5).font = { bold: true };
    rows.forEach((r, i) => {
      ws3.getRow(i + 6).values = [
        i + 1, r.materialName, r.spec ?? '', r.unit ?? '',
        r.unitPrice, r.deductPrice, r.designQtyCum, r.lossRate, r.designSubtotal,
        r.usedCum, r.stockTakeQty, r.actualUse, r.saveOver, r.deductAmount,
        r.actualLossRate == null ? null : r.actualLossRate * 100, r.remark ?? '',
      ];
    });
    // 底部三行扣款合计（本期 = Σ扣款；上期 = 上一期同分包单位单据；开累 = 上期开累 + 本期）
    const deductThis = rows.reduce((s, r) => s + (r.deductAmount ?? 0), 0);
    // 「至上期末开累」= 以前**全部**结算期的扣款之和（只取紧邻上一张会把第三期起的开累算少）
    const prevDocs = await this.prisma.laborReceivingDoc.findMany({
      where: { projectId: doc.projectId, laborAuthId: doc.laborAuthId, period: { lt: doc.period } },
      orderBy: { period: 'asc' },
    });
    let deductPrev = 0;
    if (prevDocs.length) {
      // 一次取库：聚合（含全部收领单）与历史已存行只查一次，逐期只做内存计算
      const startDay = await this.projectStartDay(doc.projectId);
      const agg = await this.aggregateReceipts(doc.projectId, doc.laborAuthId, startDay);
      const allSaved = await this.prisma.laborReceivingSummary.findMany({
        where: { projectId: doc.projectId, laborAuthId: doc.laborAuthId },
        orderBy: [{ period: 'asc' }, { materialName: 'asc' }],
      });
      for (const p of prevDocs) {
        const savedForPeriod = allSaved.filter((r) => r.period === p.period);
        const prevRows = this.buildRows(p.period, savedForPeriod, agg, allSaved);
        deductPrev += prevRows.reduce((sum, r) => sum + (r.deductAmount ?? 0), 0);
      }
    }
    let foot3 = rows.length + 6;
    ws3.getRow(foot3).values = ['至本期末开累扣款（元）', '', '', '', '', '', '', '', '', '', '', '', '', round2(deductPrev + deductThis)];
    ws3.getRow(foot3).font = { bold: true };
    ws3.getRow(foot3 + 1).values = ['至上期末开累扣款（元）', '', '', '', '', '', '', '', '', '', '', '', '', round2(deductPrev)];
    ws3.getRow(foot3 + 1).font = { bold: true };
    ws3.getRow(foot3 + 2).values = ['本期扣款（元）', '', '', '', '', '', '', '', '', '', '', '', '', round2(deductThis)];
    ws3.getRow(foot3 + 2).font = { bold: true };
    ws3.getRow(foot3 + 4).values = ['劳务单位负责人：'];
    ws3.getRow(foot3 + 6).values = ['项目部', '物资设备部：', '', '合约部：', '', '财务部：'];
    ws3.columns.forEach((c) => (c.width = 15));

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /**
   * 某分包单位某结算期的**节超快照行**（月度盈亏分析明细的取数入口；
   * 与 mergeDocRows 同源的派生口径，只是返回精简结构）。
   */
  async periodSnapshotRows(subcontractorId: string, period: string, projectId: string) {
    const startDay = await this.projectStartDay(projectId);
    const agg = await this.aggregateReceipts(projectId, subcontractorId, startDay);
    const saved = await this.prisma.laborReceivingSummary.findMany({
      where: { projectId, laborAuthId: subcontractorId },
      orderBy: [{ period: 'asc' }, { materialName: 'asc' }],
    });
    const prevCumByMat = this.buildPrevCumMap(saved, agg.receivedByPeriod, period);
    const periodRows = agg.receivedByPeriod.get(period) ?? new Map();
    const savedPeriodRows = saved.filter((r) => r.period === period);
    // 本期的行键统一用**两段键**（材料 + 规格）：自动聚合桶与已存行同形状，
    // 含期的三段键只用于查「上期末累计」，不能混进 rows/keys（否则 parseRowKey 会把期间当材料名）
    const savedByMat = new Map(savedPeriodRows.map((r) => [rowKey(r.materialName, r.spec), r] as const));
    const keys = new Set<string>([...periodRows.keys(), ...savedByMat.keys()]);
    const out: any[] = [];
    for (const key of keys) {
      const { materialName, spec } = parseRowKey(key);
      const savedRow = savedByMat.get(key);
      const auto = periodRows.get(key);
      const receivedQty = auto?.qty ?? null;
      const unitPrice =
        savedRow?.priceOverridden && savedRow.unitPrice != null
          ? Number(savedRow.unitPrice)
          : agg.avgPriceByKey.get(key) ?? (savedRow?.unitPrice != null ? Number(savedRow.unitPrice) : null);
      const derived = deriveReceivingRow({
        prevCum: prevCumByMat.get(key) ?? 0,
        receivedQty,
        returnQty: savedRow?.returnQty != null ? Number(savedRow.returnQty) : null,
        stockTakeQty: savedRow?.stockTakeQty != null ? Number(savedRow.stockTakeQty) : null,
        designQtyCum: savedRow?.designQtyCum != null ? Number(savedRow.designQtyCum) : null,
        lossRate: savedRow?.lossRate != null ? Number(savedRow.lossRate) : null,
        unitPrice,
      });
      out.push({
        laborAuthId: subcontractorId,
        materialName,
        spec: spec ?? '',
        unit: auto?.unit ?? savedRow?.unit ?? null,
        unitPrice,
        entryQty: derived.usedCum, // 进场量 = 至本期末累计领用
        designQty: savedRow?.designQtyCum != null ? Number(savedRow.designQtyCum) : null,
        lossRate: savedRow?.lossRate != null ? Number(savedRow.lossRate) : null,
        theoryUseQty: derived.designSubtotal,
        actualUseQty: derived.actualUse,
        stockQty: savedRow?.stockTakeQty != null ? Number(savedRow.stockTakeQty) : null,
        saveOverQty: derived.saveOver,
        remark: savedRow?.remark ?? '',
      });
    }
    return out;
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
   * 收领单明细聚合（按 `laborAuthId` 关联——不按名称）：
   * - `receivedByPeriod`：期标签 → (材料key → 本期领用数量/单位)；
   * - `avgPriceByKey`：材料key → 全期间平均单价（Σ税前总价 ÷ Σ数量）。
   */
  private async aggregateReceipts(projectId: string, laborAuthId: string, startDay: number) {
    const orders = await this.prisma.receiptOrder.findMany({
      where: {
        projectId,
        receivingUnitType: 'SUBCONTRACTOR',
        // 分包单位在收领单上可能出现在两侧：供应单位（subcontractorId）或领用单位（receivingUnitId）
        OR: [{ subcontractorId: laborAuthId }, { receivingUnitId: laborAuthId }],
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
        const key = rowKey(name, d.specModel || '');
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
   * 目标期期初开累：J(目标期) = Σ 历史期（领用 − 退库），首期 0。
   *
   * ⚠️ 返回的键是**材料键 rowKey(materialName, spec)**（不含期间），与 `mergeDocRows()` /
   * `periodSnapshotRows()` 的行键同形状。此前这里用含期的三段键建 map、调用方却用两段键查，
   * 导致上期开累恒为 0（跨期只累加了上一期退库）；同时 `aggregateReceipts()` 的桶一直是
   * 两段键，旧代码却按三段键去取自动领用量，也同样取不到。
   *
   * 历史期同时遍历「已存行」与「收领单自动聚合」，保证没有手填行的历史期领用也计入开累；
   * 期间标签为 `YYYY-MM`，字符串序即时间序。
   */
  private buildPrevCumMap(
    saved: any[],
    receivedByPeriod: Map<string, Map<string, { qty: number }>>,
    targetPeriod: string,
  ): Map<string, number> {
    const cumByMat = new Map<string, number>();
    const periods = new Set<string>([...saved.map((r) => r.period), ...receivedByPeriod.keys()]);
    const ordered = Array.from(periods)
      .filter((p) => p && p < targetPeriod)
      .sort();
    for (const period of ordered) {
      const savedByMat = new Map<string, any>();
      for (const r of saved) {
        if (r.period === period) savedByMat.set(rowKey(r.materialName, r.spec), r);
      }
      const autoRows = receivedByPeriod.get(period) ?? new Map<string, { qty: number }>();
      const matKeys = new Set<string>([...savedByMat.keys(), ...autoRows.keys()]);
      for (const matKey of matKeys) {
        const received = autoRows.get(matKey)?.qty ?? 0;
        const ret = savedByMat.get(matKey)?.returnQty != null ? Number(savedByMat.get(matKey).returnQty) : 0;
        cumByMat.set(matKey, (cumByMat.get(matKey) ?? 0) + received - ret);
      }
    }
    return cumByMat;
  }

  /** 单据期标签为 fullKey（含期）；行内键不含期 */
  private serializeDoc(r: any, detailCount?: number) {
    return {
      id: r.id,
      docNo: r.docNo,
      laborAuthId: r.laborAuthId,
      subcontractorName: r.subcontractorName,
      period: r.period,
      contractName: r.contractName ?? '',
      status: r.status,
      remark: r.remark ?? '',
      detailCount: detailCount ?? r._count?.details ?? undefined,
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

/**
 * 材料行键：`rowKey(materialName, spec)`——**不含期间**，单据内/统计期的行身份一律用它。
 * 期间只作为查询条件/分组维度，绝不拼进行键（拼进去会让 parseRowKey 把期间当材料名）。
 */
function rowKey(materialName: string, spec: string): string {
  return [materialName, spec].join('\u0001');
}

function parseRowKey(key: string): { materialName: string; spec: string } {
  const idx = key.indexOf('\u0001');
  return idx < 0 ? { materialName: key, spec: '' } : { materialName: key.slice(0, idx), spec: key.slice(idx + 1) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 'YYYY-MM' → 'YYYY年M月'；认不出原样返回 */
function periodLabelOf(period: string): string {
  const m = String(period).match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[1]}年${Number(m[2])}月` : period;
}
