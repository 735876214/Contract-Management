import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';

const SETTLE_FIELDS = [
  'projectId', 'contractId', 'code', 'typeCode', 'amount', 'deductAmount', 'actualAmount',
  'settleDate', 'statusCode', 'remark',
];
const LEDGER_FIELDS = [
  'projectId', 'contractId', 'settleMonth', 'monthSettleAmount', 'monthInvoiceAmount', 'settleCount',
  'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount', 'monthActualPurchase',
  'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome', 'isOnAccount', 'remark',
];

@Injectable()
export class SettlementService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private styled: StyledExcelService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
  ) {}

  // ---------------- 结算单 ----------------
  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { contract: { name: { contains: query.keyword } } }];
    const [list, total] = await Promise.all([
      this.prisma.settlement.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { contract: { select: { id: true, code: true, name: true, supplierId: true, supplier: { select: { id: true, name: true } } } } },
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const s = await this.prisma.settlement.findUnique({ where: { id }, include: { contract: true } });
    if (!s) throw new NotFoundException('结算单不存在');
    return s;
  }

  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.dict.validate('settlement_type', data.typeCode);
    await this.dict.validate('settlement_status', data.statusCode);
    const actual = data.actualAmount ?? (num(data.amount) || 0) - (num(data.deductAmount) || 0);
    return db.settlement.create({
      data: {
        ...pickFields(data, SETTLE_FIELDS, { label: '结算单' }), projectId,
        amount: num(data.amount), deductAmount: num(data.deductAmount), actualAmount: num(actual),
        settleDate: toDate(data.settleDate),
      },
    });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    await this.dict.validate('settlement_type', data.typeCode);
    await this.dict.validate('settlement_status', data.statusCode);
    const payload: any = pickFields(data, SETTLE_FIELDS, { label: '结算单' });
    ['amount', 'deductAmount', 'actualAmount'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (data.settleDate) payload.settleDate = toDate(data.settleDate);
    delete payload.version;
    return this.prisma.settlement.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.settlement.delete({ where: { id } });
    return true;
  }

  // ---------------- 结算台账 ----------------

  /** 日期 → YYYY-MM */
  private monthOf(d: any): string | null {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * 结算台账自动抓取字段（数据自动生成，不依赖手工录入）：
   * - 本月结算额 / 结算次数：按结算月份从结算单（Settlement.settleDate）抓取实结金额
   * - 本月开票额：从发票管理收票登记（Invoice）按结算账期抓取，无账期时回落到开票日期月份
   * - 保理贴息：从资金费用台账保理费用（FactoringCost，融资利息 + 手续费）按结算月份抓取
   * - 逾期利息：从资金费用台账逾期利息（OverdueInterest，未减免行）按结算月份抓取
   */
  async computeLedgerAutoFields(contractId: string, settleMonth: string) {
    const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
    const [y, m] = settleMonth.split('-').map(Number);
    let start: Date | null = null;
    let end: Date | null = null;
    if (y && m) {
      start = new Date(y, m - 1, 1);
      end = new Date(y, m, 1);
    }
    const [settlements, invoices, factoring, overdue] = await Promise.all([
      start && end
        ? this.prisma.settlement.findMany({ where: { contractId, settleDate: { gte: start, lt: end } } })
        : Promise.resolve([] as any[]),
      this.prisma.invoice.findMany({ where: { contractId } }),
      this.prisma.factoringCost.findMany({ where: { contractId, settlementMonth: settleMonth } }),
      this.prisma.overdueInterest.findMany({ where: { contractId, settlementMonth: settleMonth } }),
    ]);
    const monthSettleAmount = round2(settlements.reduce((s: number, r: any) => s + (num(r.actualAmount ?? r.amount) || 0), 0));
    const settleCount = settlements.length;
    const monthInvoiceAmount = round2(
      invoices
        .filter((i: any) => (i.settlePeriod || this.monthOf(i.invoiceDate)) === settleMonth)
        .reduce((s: number, i: any) => s + (num(i.amountWithTax) || 0), 0),
    );
    const factoringDiscount = round2(
      factoring.reduce((s: number, r: any) => {
        const cost = num(r.totalCost) ?? (num(r.financingInterest) || 0) + (num(r.handlingFee) || 0);
        return s + (cost || 0);
      }, 0),
    );
    const overdueSum = round2(overdue.reduce((s: number, r: any) => (r.waived ? s : s + (num(r.overdueInterest) || 0)), 0));
    return { monthSettleAmount, monthInvoiceAmount, settleCount, factoringDiscount, overdueInterest: overdueSum };
  }

  /**
   * 需求 2.3：合同物资/金额变更时，自动重新派生该合同下全部结算台账的自动抓取字段
   * （本月结算额、本月开票额、结算次数、保理贴息、逾期利息）
   */
  async syncLedgerByContract(contractId: string, tx?: TxClient) {
    if (!contractId) return 0;
    const db: any = tx || this.prisma;
    const rows = await db.settlementLedger.findMany({
      where: { contractId },
      select: { id: true, settleMonth: true },
    });
    for (const r of rows) {
      const auto = await this.computeLedgerAutoFields(contractId, r.settleMonth);
      await db.settlementLedger.update({ where: { id: r.id }, data: { ...auto, version: { increment: 1 } } });
    }
    return rows.length;
  }

  /** 一键自动生成/刷新台账：扫描结算单、收票登记、资金费用台账中的合同+月份组合，自动生成缺失行并刷新自动字段 */
  async refreshLedger(projectId: string) {
    const [settlements, invoices, factoring, overdue, contracts] = await Promise.all([
      this.prisma.settlement.findMany({ where: { projectId }, select: { contractId: true, settleDate: true } }),
      this.prisma.invoice.findMany({ where: { projectId }, select: { contractId: true, settlePeriod: true, invoiceDate: true } }),
      this.prisma.factoringCost.findMany({ select: { contractId: true, settlementMonth: true } }),
      this.prisma.overdueInterest.findMany({ select: { contractId: true, settlementMonth: true } }),
      this.prisma.contract.findMany({ where: { projectId }, select: { id: true } }),
    ]);
    const contractIds = new Set(contracts.map((c: any) => c.id));
    const combos = new Set<string>();
    const add = (contractId: string | null, month: string | null) => {
      if (contractId && month) combos.add(`${contractId}|${month}`);
    };
    for (const s of settlements) add(s.contractId, this.monthOf(s.settleDate));
    for (const i of invoices) add(i.contractId, i.settlePeriod || this.monthOf(i.invoiceDate));
    for (const f of factoring) if (contractIds.has(f.contractId)) add(f.contractId, f.settlementMonth);
    for (const o of overdue) if (contractIds.has(o.contractId)) add(o.contractId, o.settlementMonth);
    let created = 0;
    let updated = 0;
    for (const combo of combos) {
      const [contractId, settleMonth] = combo.split('|');
      const auto = await this.computeLedgerAutoFields(contractId, settleMonth);
      const exist = await this.prisma.settlementLedger.findFirst({ where: { projectId, contractId, settleMonth } });
      if (exist) {
        await this.prisma.settlementLedger.update({ where: { id: exist.id }, data: auto });
        updated++;
      } else {
        await this.prisma.settlementLedger.create({ data: { projectId, contractId, settleMonth, ...auto } });
        created++;
      }
    }
    return { created, updated };
  }

  async findLedger(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.settleMonth) where.settleMonth = query.settleMonth;
    if (query.isOnAccount) where.isOnAccount = query.isOnAccount;
    const [list, total] = await Promise.all([
      this.prisma.settlementLedger.findMany({
        where, skip, take, orderBy: [{ settleMonth: 'desc' }, { createdAt: 'desc' }],
        include: { contract: { select: { id: true, code: true, name: true, supplier: { select: { id: true, name: true } } } } },
      }),
      this.prisma.settlementLedger.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async ledgerOne(id: string) {
    const l = await this.prisma.settlementLedger.findUnique({ where: { id } });
    if (!l) throw new NotFoundException('结算台账记录不存在');
    return l;
  }

  async createLedger(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = { ...pickFields(data, LEDGER_FIELDS, { label: '结算台账' }), projectId };
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    // 自动生成：本月结算额/本月开票额/结算次数/保理贴息/逾期利息 从业务数据自动抓取，忽略手工传入
    if (payload.contractId && payload.settleMonth) {
      Object.assign(payload, await this.computeLedgerAutoFields(payload.contractId, payload.settleMonth));
    }
    return db.settlementLedger.create({ data: payload });
  }

  async updateLedger(id: string, data: any) {
    const old = await this.ledgerOne(id);
    assertVersion(old, data);
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = pickFields(data, LEDGER_FIELDS, { label: '结算台账' });
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    // 自动生成：以本次变更后的合同+月份为准重新抓取
    const contractId = payload.contractId ?? old.contractId;
    const settleMonth = payload.settleMonth ?? old.settleMonth;
    if (contractId && settleMonth) {
      Object.assign(payload, await this.computeLedgerAutoFields(contractId, settleMonth));
    }
    delete payload.version;
    return this.prisma.settlementLedger.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async removeLedger(id: string) {
    await this.ledgerOne(id);
    await this.prisma.settlementLedger.delete({ where: { id } });
    return true;
  }

  /** 月度结算单合规性检查表（需求 2.7）：表头信息 + 检查项清单 + 签字区 */
  async exportComplianceSheet(contractId: string, projectId: string, year?: number, month?: number) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { name: true } }, project: { select: { name: true } } },
    });
    if (!contract) throw new NotFoundException('合同不存在');
    const project = contract.project || (await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }));
    const info = [
      ['项目名称', project?.name || ''],
      ['分供方名称', contract.supplier?.name || ''],
      ['合同名称', contract.name],
      ['年度 / 月份', `${year || '____'} 年 ${month || '__'} 月`],
    ];
    const CHECKS: [string, string][] = [
      ['进场依据（首期月度结算填报）', '开始招标时间'],
      ['', '首次进场时间'],
      ['', '是否为先进场后招标（是 □　否 □）'],
      ['', '定标时间'],
      ['', '是否为先进场后定标（是 □　否 □）'],
      ['', '合同签订时间'],
      ['', '是否为先进场后签合同（是 □　否 □）'],
      ['结算增项情况', '结算清单未超合同清单（是 □　否 □）'],
      ['收验货系统', '是否为上传收验货系统物资（是 □　否 □）'],
      ['', '上传收验货系统数量'],
      ['', '上传收验货系统数量占比'],
      ['', '未传收验货系统数量'],
      ['', '未传收验货系统数量占比'],
      ['结算增量情况', '结算额占合同额比例（未超100% □　100%-110% □　110%-130% □　130%以上 □）'],
      ['签字盖章合规性', '供应商签字为法人或授权委托人签字（是 □　否 □）'],
      ['', '（分包）收料人员签字有材料员授权委托书（是 □　否 □）'],
      ['', '盖章为公章或公章授权章（是 □　否 □）'],
      ['对账周期', '按对账周期结算（是 □　否 □）'],
      ['结算支撑材料', '结算依据充足准确（是 □　否 □）'],
      ['结算办理严谨性', '物资名称、规格型号与合同清单相同（是 □　否 □）'],
      ['', '基本信息无漏填（是 □　否 □）'],
      ['', '资料格式美观整洁（是 □　否 □）'],
    ];
    let lastGroup = '';
    const rows = CHECKS.map(([g, item]) => {
      if (g) lastGroup = g;
      return { group: lastGroup, item, result: '', note: '' };
    });
    return this.styled.withWorkbook(async (wb) => {
      const ws = wb.addWorksheet('合规性检查表', { views: [{ state: 'frozen', ySplit: 8 }] });
      const colCount = 4;
      // 品牌行 + 标题行
      ws.mergeCells(1, 1, 1, colCount);
      const brand = ws.getCell(1, 1);
      brand.value = '〖中国建筑〗中国建筑土木建设有限公司物资管理表格';
      brand.font = { bold: true, size: 14, name: '微软雅黑' };
      brand.alignment = { horizontal: 'left', vertical: 'middle' };
      ws.getRow(1).height = 26;
      ws.mergeCells(2, 1, 2, colCount);
      const title = ws.getCell(2, 1);
      title.value = '月度结算单合规性检查表';
      title.font = { bold: true, size: 13, name: '微软雅黑' };
      title.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(2).height = 24;
      // 表头信息区
      info.forEach(([label, value], i) => {
        const r = 3 + i;
        ws.getCell(r, 1).value = label;
        ws.getCell(r, 1).font = { bold: true, size: 10.5, name: '微软雅黑' };
        ws.mergeCells(r, 2, r, colCount);
        ws.getCell(r, 2).value = value;
        ws.getCell(r, 2).font = { size: 10.5, name: '微软雅黑' };
        for (let c = 1; c <= colCount; c++) ws.getCell(r, c).border = {
          top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' },
        };
      });
      // 检查项表头
      const headerRowIdx = 3 + info.length;
      const header = ws.getRow(headerRowIdx);
      ['检查分组', '检查项', '检查结果', '备注说明'].forEach((h, i) => {
        const cell = header.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, size: 11, name: '微软雅黑' };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      header.height = 22;
      // 检查项行
      rows.forEach((r, ri) => {
        const row = ws.getRow(headerRowIdx + 1 + ri);
        [r.group, r.item, r.result, r.note].forEach((v, ci) => {
          const cell = row.getCell(ci + 1);
          cell.value = v || null;
          cell.font = { size: 10.5, name: '微软雅黑' };
          cell.alignment = { horizontal: ci === 1 ? 'left' : 'center', vertical: 'middle', wrapText: ci === 1 };
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
      });
      // 签字区
      const signRow = headerRowIdx + rows.length + 2;
      ws.getCell(signRow, 1).value = '项目经办人签字：____________';
      ws.getCell(signRow, 3).value = '物资部负责人复核：____________';
      ws.getCell(signRow, 1).font = { size: 10.5, name: '微软雅黑' };
      ws.getCell(signRow, 3).font = { size: 10.5, name: '微软雅黑' };
      ws.getColumn(1).width = 24;
      ws.getColumn(2).width = 56;
      ws.getColumn(3).width = 22;
      ws.getColumn(4).width = 20;
      ws.pageSetup = {
        paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        printTitlesRow: `1:${headerRowIdx}`, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 },
      };
    });
  }

  async exportLedger(projectId: string) {
    const res = await this.findLedger({ pageSize: 2000 }, projectId);
    const yesNo = await this.dict.nameMap('yes_no');
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const rows = (res.list as any[]).map((r) => ({
      projectName: project?.name || '',
      supplierName: r.contract?.supplier?.name, contractName: r.contract?.name, contractCode: r.contract?.code,
      settleMonth: r.settleMonth, monthSettleAmount: num(r.monthSettleAmount), monthInvoiceAmount: num(r.monthInvoiceAmount),
      settleCount: r.settleCount, yearSettleAmount: num(r.yearSettleAmount), monthActualPurchaseReview: num(r.monthActualPurchase),
      cumPurchaseAmount: num(r.cumPurchaseAmount),
      startSettleAmount: num(r.startSettleAmount), monthActualPurchase: num(r.monthActualPurchase),
      factoringDiscount: num(r.factoringDiscount), overdueInterest: num(r.overdueInterest),
      yearSettleIncome: num(r.yearSettleIncome), cumSettleIncome: num(r.cumSettleIncome),
      isOnAccountName: yesNo[r.isOnAccount]?.name || '',
    }));
    return this.styled.exportTable({
      sheetName: '结算台账',
      logoColumn: true,
      title: `结算台账（${project?.name || ''}）`,
      columns: [
        { header: '项目', key: 'projectName', width: 140, type: 'center' },
        { header: '供应商名称', key: 'supplierName', width: 180 },
        { header: '合同名称', key: 'contractName', width: 200 },
        { header: '合同编号', key: 'contractCode', width: 180 },
        { header: '结算月份', key: 'settleMonth', width: 100, type: 'center' },
        { header: '本月结算额 a', key: 'monthSettleAmount', width: 140, type: 'money' },
        { header: '本月开票额', key: 'monthInvoiceAmount', width: 130, type: 'money' },
        { header: '结算次数', key: 'settleCount', width: 80, type: 'int' },
        { header: '本年结算额', key: 'yearSettleAmount', width: 140, type: 'money' },
        { header: '本月采购额（公式复核）', key: 'monthActualPurchaseReview', width: 160, type: 'money' },
        { header: '截止当月开累采购额', key: 'cumPurchaseAmount', width: 160, type: 'money' },
        { header: '开工结算额', key: 'startSettleAmount', width: 130, type: 'money' },
        { header: '当月实际采购额 b', key: 'monthActualPurchase', width: 140, type: 'money' },
        { header: '保理贴息 c', key: 'factoringDiscount', width: 110, type: 'money' },
        { header: '逾期利息 d', key: 'overdueInterest', width: 110, type: 'money' },
        { header: '本年结算对应收入（含税）', key: 'yearSettleIncome', width: 180, type: 'money' },
        { header: '开累结算对应收入（含税）', key: 'cumSettleIncome', width: 180, type: 'money' },
        { header: '是否挂账', key: 'isOnAccountName', width: 90, type: 'center' },
      ],
      rows,
      totalsKeys: ['monthSettleAmount', 'monthInvoiceAmount', 'monthActualPurchase', 'factoringDiscount', 'overdueInterest'],
      totalsLabel: '汇总',
    });
  }

  /** 结算台账填写模板（需求 3.3，实际字段口径） */
  async templateLedger(projectId: string) {
    const yesNo = await this.dict.options('yes_no');
    const columns: TemplateColumn[] = [
      { label: '合同编号', key: 'contractCode', required: true, width: 20, example: 'HT-2026-0001', desc: '须为合同台账中已存在的合同编号' },
      { label: '结算月份', key: 'settleMonth', required: true, type: 'text', width: 14, example: '2026-08', desc: '格式 YYYY-MM' },
      { label: '本月结算额', key: 'monthSettleAmount', type: 'money', width: 16, example: 1234567.89 },
      { label: '本月开票额', key: 'monthInvoiceAmount', type: 'money', width: 16, example: 1396621.72 },
      { label: '结算次数', key: 'settleCount', type: 'int', width: 10, example: 2 },
      { label: '开累采购额', key: 'cumPurchaseAmount', type: 'money', width: 16, example: 50000000 },
      { label: '开工结算额', key: 'startSettleAmount', type: 'money', width: 16, example: 1000000 },
      { label: '本月实际采购额', key: 'monthActualPurchase', type: 'money', width: 16, example: 1180000 },
      { label: '保理贴息', key: 'factoringDiscount', type: 'money', width: 14, example: 12345.67 },
      { label: '逾期利息', key: 'overdueInterest', type: 'money', width: 14, example: 0 },
      { label: '本年结算收入', key: 'yearSettleIncome', type: 'money', width: 16, example: 8000000 },
      { label: '开累结算收入', key: 'cumSettleIncome', type: 'money', width: 16, example: 9000000 },
      { label: '是否挂账', key: 'isOnAccount', type: 'select', width: 10, example: '否', options: yesNo.map((i: any) => i.itemName).filter(Boolean) },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '结算台账', sheetName: '数据', columns });
  }

  /** 结算台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importLedger(buffer: Buffer, projectId: string, meta?: { fileName?: string; user?: any }) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'settlement-ledger', moduleName: '结算台账', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const month = String(r['结算月份'] ?? '').trim();
        if (!/^\d{4}-\d{2}$/.test(month)) throw new RowError('结算月份为必填项，格式 YYYY-MM（如 2026-08）', '结算月份');
        notDup(`${contract.id}|${month}`, `唯一性校验失败：该合同 ${month} 的记录在本次导入中重复`, '结算月份');
        const dup = await this.prisma.settlementLedger.findFirst({
          where: { projectId, contractId: contract.id, settleMonth: month },
        });
        if (dup) throw new RowError(`唯一性校验失败：该合同 ${month} 的结算台账已存在，导入不覆盖已有数据`, '结算月份');
        const isOnAccount = String(r['是否挂账'] ?? '').trim();
        return {
          data: {
            contractId: contract.id,
            settleMonth: month,
            monthSettleAmount: num(r['本月结算额']),
            monthInvoiceAmount: num(r['本月开票额']),
            settleCount: num(r['结算次数']),
            cumPurchaseAmount: num(r['开累采购额']),
            startSettleAmount: num(r['开工结算额']),
            monthActualPurchase: num(r['本月实际采购额']),
            factoringDiscount: num(r['保理贴息']),
            overdueInterest: num(r['逾期利息']),
            yearSettleIncome: num(r['本年结算收入']),
            cumSettleIncome: num(r['开累结算收入']),
            isOnAccount: isOnAccount || null,
            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.createLedger(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }
}
