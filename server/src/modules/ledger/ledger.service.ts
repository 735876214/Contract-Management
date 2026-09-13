import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, ratio, fmtDate, IMPORT_MAX_ROWS } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';

/** 合同台账列定义（顺序固定，可配置显示/隐藏） */
export const LEDGER_COLUMNS: { key: string; title: string; width?: number; defaultHidden?: boolean }[] = [
  { key: 'index', title: '序号', width: 8 },
  { key: 'contractCode', title: '合同编号', width: 20 },
  { key: 'financeCode', title: '财务一体化合同编号', width: 22 },
  { key: 'supplierName', title: '供应单位', width: 28 },
  { key: 'materialNames', title: '供应材料', width: 24 },
  { key: 'procurementSource', title: '采购来源', width: 14 },
  { key: 'isDirectPurchase', title: '是否厂家直采', width: 14 },
  { key: 'contractName', title: '合同名称', width: 30 },
  { key: 'bidName', title: '招标名称', width: 24 },
  { key: 'execStatus', title: '合同执行情况', width: 14 },
  { key: 'supplierCategory', title: '分供方类别', width: 14 },
  { key: 'legalPerson', title: '法人', width: 12 },
  { key: 'authPerson', title: '授权人', width: 12 },
  { key: 'contactName', title: '联系人', width: 12 },
  { key: 'contactPhone', title: '联系人电话', width: 14 },
  { key: 'amount', title: '合同额', width: 16 },
  { key: 'taxRate', title: '税率', width: 10 },
  { key: 'currentPayRatio', title: '当前合同付款比例', width: 16 },
  { key: 'paymentMethod', title: '合同约定付款方式', width: 16 },
  { key: 'isSupplement', title: '是否补充协议', width: 14 },
  { key: 'supplementType', title: '补充协议类型', width: 16 },
  { key: 'bidStartDate', title: '开始招标时间', width: 14 },
  { key: 'bidWinDate', title: '定标时间', width: 14 },
  { key: 'signDate', title: '合同签订时间', width: 14 },
  { key: 'disclosureDate', title: '合同交底时间', width: 14 },
  { key: 'firstEntryDate', title: '首次进场时间', width: 14 },
  { key: 'compliance', title: '合规性问题', width: 18 },
  { key: 'complaint', title: '投诉情况', width: 18 },
  { key: 'cumSettleAmount', title: '开累结算金额', width: 16 },
  { key: 'auditedSettleAmount', title: '审定结算额', width: 16 },
  { key: 'cumSettleBeforeTax', title: '开累税前结算金额', width: 18 },
  { key: 'cumInputTax', title: '开累进项税额', width: 16 },
  { key: 'cumInvoiceAmount', title: '开累发票金额', width: 16 },
  { key: 'cumPaidAmount', title: '开累付款金额', width: 16 },
  { key: 'payableAmount', title: '应付款金额', width: 16 },
  { key: 'unpaidAmount', title: '应付未付金额', width: 16 },
  { key: 'debt100', title: '100%欠款', width: 16 },
  { key: 'settleRatio', title: '已结算金额占合同比例', width: 18 },
  { key: 'paidRatio', title: '已付款金额占结算比例', width: 18 },
  { key: 'settleReduceAmount', title: '总结算审减额', width: 16 },
  { key: 'yearSettle', title: '每年结算金额', width: 20, defaultHidden: true },
  { key: 'yearPaid', title: '每年付款金额', width: 20, defaultHidden: true },
];

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private sysParam: SysParamService,
    private styled: StyledExcelService,
  ) {}

  /**
   * 合同台账：以合同为主表，批量聚合（避免 N+1）
   * 供应商法人/授权人/联系人等信息通过 supplierId 实时关联，不落合同表
   */
  async findAll(query: any = {}, projectId: string, maxPageSize = 500) {
    const { skip, take } = paginate(query, maxPageSize);
    const where: any = { projectId };
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { name: { contains: query.keyword } }];
    if (query.contractCode) where.code = { contains: query.contractCode };
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.execStatus) where.execStatus = query.execStatus;
    if (query.supplierCategory) where.ext = { supplierCategory: query.supplierCategory };
    if (query.compliance) (query as any)._compliance = query.compliance;

    const [contracts, total] = await Promise.all([
      this.prisma.contract.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { supplier: true, ext: true },
      }),
      this.prisma.contract.count({ where }),
    ]);

    const contractIds = contracts.map((c: any) => c.id);

    // 批量聚合（一次性查询后在内存分组，避免 N+1）
    const [items, reports, ledger, settlements, invoices, payments] = await Promise.all([
      this.prisma.contractMaterial.findMany({
        where: { contractId: { in: contractIds } },
        select: { contractId: true, materialBase: { select: { name: true } } },
      }),
      this.prisma.dailyReport.findMany({ where: { contractId: { in: contractIds } }, select: { contractId: true, entryDate: true } }),
      this.prisma.settlementLedger.findMany({ where: { contractId: { in: contractIds } }, select: { contractId: true, settleMonth: true, monthSettleAmount: true } }),
      this.prisma.settlement.findMany({ where: { contractId: { in: contractIds } }, select: { contractId: true, actualAmount: true } }),
      this.prisma.invoice.findMany({ where: { contractId: { in: contractIds } }, select: { contractId: true, amountWithTax: true } }),
      this.prisma.paymentRecord.findMany({ where: { contractId: { in: contractIds } }, select: { contractId: true, payMonth: true, amount: true } }),
    ]);

    const groupBy = (list: any[], key: string) =>
      list.reduce((acc: any, i: any) => {
        (acc[i[key]] = acc[i[key]] || []).push(i);
        return acc;
      }, {});

    const itemMap = groupBy(items, 'contractId');
    const reportMap = groupBy(reports, 'contractId');
    const ledgerMap = groupBy(ledger, 'contractId');
    const settleMap = groupBy(settlements, 'contractId');
    const invoiceMap = groupBy(invoices, 'contractId');
    const payMap = groupBy(payments, 'contractId');

    const [execMap, payMethodMap, yesNoMap, supTypeMap, procMap, directMap, supCatMap] = await Promise.all([
      this.dict.nameMap('contract_execution_status'),
      this.dict.nameMap('payment_method'),
      this.dict.nameMap('yes_no'),
      this.dict.nameMap('supplement_agreement_type'),
      this.dict.nameMap('procurement_source'),
      this.dict.nameMap('is_direct_purchase'),
      this.dict.nameMap('supplier_category'),
    ]);

    let rows = contracts.map((c: any, idx: number) => {
      const sup: any = c.supplier || {};
      const ext: any = c.ext || {};
      const taxRate = num(c.taxRate);
      const amount = num(c.amount) || 0;

      // 供应材料：来自合同物资清单
      const materialNames = Array.from(new Set((itemMap[c.id] || []).map((i: any) => i.materialBase?.name).filter(Boolean))).join('、');

      // 首次进场时间：该合同下日报最早进场日期
      const entryDates = (reportMap[c.id] || []).map((r: any) => r.entryDate).filter(Boolean);
      const firstEntryDate = entryDates.length ? new Date(Math.min(...entryDates.map((d: any) => new Date(d).getTime()))) : null;

      // 开累结算金额：结算台账「本月结算额」之和
      const cumSettleAmount = (ledgerMap[c.id] || []).reduce((s, l: any) => s + (num(l.monthSettleAmount) || 0), 0);
      // 审定结算额：结算单实际结算金额之和
      const auditedSettleAmount = (settleMap[c.id] || []).reduce((s, x: any) => s + (num(x.actualAmount) || 0), 0);
      // 开累税前结算金额 = 含税 / (1 + 税率)
      const cumSettleBeforeTax = taxRate ? Number((cumSettleAmount / (1 + taxRate)).toFixed(2)) : cumSettleAmount;
      const cumInputTax = Number((cumSettleAmount - cumSettleBeforeTax).toFixed(2));
      const cumInvoiceAmount = (invoiceMap[c.id] || []).reduce((s, i: any) => s + (num(i.amountWithTax) || 0), 0);
      const cumPaidAmount = (payMap[c.id] || []).reduce((s, p: any) => s + (num(p.amount) || 0), 0);

      // 每年结算金额 / 每年付款金额
      const yearSettle: Record<string, number> = {};
      (ledgerMap[c.id] || []).forEach((l: any) => {
        const y = (l.settleMonth || '').slice(0, 4);
        if (y) yearSettle[y] = Number(((yearSettle[y] || 0) + (num(l.monthSettleAmount) || 0)).toFixed(2));
      });
      const yearPaid: Record<string, number> = {};
      (payMap[c.id] || []).forEach((p: any) => {
        const y = (p.payMonth || '').slice(0, 4);
        if (y) yearPaid[y] = Number(((yearPaid[y] || 0) + (num(p.amount) || 0)).toFixed(2));
      });

      const compliance = this.calcCompliance(c.typeCode, firstEntryDate, ext.bidStartDate, ext.bidWinDate, c.signDate);

      return {
        id: c.id,
        index: idx + 1,
        contractCode: c.code,
        financeCode: ext.financeCode,
        supplierName: sup.name,
        materialNames,
        procurementSource: procMap[ext.procurementSrc]?.name || ext.procurementSrc || '',
        isDirectPurchase: directMap[ext.isDirectPurchase]?.name || ext.isDirectPurchase || '',
        contractName: c.name,
        bidName: ext.bidName,
        execStatus: execMap[c.execStatus]?.name || c.execStatus || '',
        supplierCategory: supCatMap[ext.supplierCategory]?.name || ext.supplierCategory || '',
        // 供应商库实时关联
        legalPerson: sup.legalPerson,
        authPerson: sup.contractAuthPerson,
        contactName: sup.contactName,
        contactPhone: sup.contactPhone,
        amount,
        taxRate,
        currentPayRatio: num(ext.currentPayRatio),
        paymentMethod: payMethodMap[c.paymentMethodCode]?.name || c.paymentMethodCode || '',
        isSupplement: yesNoMap[c.isSupplement]?.name || c.isSupplement || '',
        supplementType: supTypeMap[c.supplementTypeCode]?.name || c.supplementTypeCode || '',
        bidStartDate: fmtDate(ext.bidStartDate),
        bidWinDate: fmtDate(ext.bidWinDate),
        signDate: fmtDate(c.signDate),
        disclosureDate: fmtDate(ext.disclosureDate),
        firstEntryDate: fmtDate(firstEntryDate),
        compliance,
        complaint: ext.complaint,
        cumSettleAmount: Number(cumSettleAmount.toFixed(2)),
        auditedSettleAmount: Number(auditedSettleAmount.toFixed(2)),
        cumSettleBeforeTax: Number(cumSettleBeforeTax.toFixed(2)),
        cumInputTax,
        cumInvoiceAmount: Number(cumInvoiceAmount.toFixed(2)),
        cumPaidAmount: Number(cumPaidAmount.toFixed(2)),
        payableAmount: Number((auditedSettleAmount * (num(ext.currentPayRatio) || 0)).toFixed(2)),
        unpaidAmount: Number((auditedSettleAmount * (num(ext.currentPayRatio) || 0) - cumPaidAmount).toFixed(2)),
        debt100: Number((amount - cumPaidAmount).toFixed(2)),
        settleRatio: ratio(cumSettleAmount, amount),
        paidRatio: ratio(cumPaidAmount, cumSettleAmount),
        settleReduceAmount: Number((auditedSettleAmount - cumSettleAmount).toFixed(2)),
        yearSettle,
        yearPaid,
      };
    });

    if ((query as any)._compliance) {
      rows = rows.filter((r: any) => r.compliance === (query as any)._compliance);
    }

    return { ...buildResult(rows, total, query), columns: await this.columns() };
  }

  /**
   * 合规性问题自动计算（不落库）
   * 执行合同：进场 ≥ 签订 → 无问题；早于 → 未签合同先进场
   * 非执行合同：依次比较 招标 → 定标 → 签订；关键时间缺失 → 时间数据不完整
   */
  private calcCompliance(typeCode: string, entry: Date | null, bidStart: any, bidWin: any, sign: any): string {
    const execTypes = ['PURCHASE_EXEC', 'LEASE_EXEC'];
    const d = (v: any) => (v ? new Date(v).getTime() : null);
    const entryT = d(entry);

    if (execTypes.includes(typeCode)) {
      if (!entryT) return '';
      const signT = d(sign);
      if (!signT) return '时间数据不完整';
      return entryT >= signT ? '无问题' : '未签合同先进场';
    }

    if (!entryT) return '时间数据不完整';
    const bidStartT = d(bidStart);
    const bidWinT = d(bidWin);
    const signT = d(sign);
    if (!bidStartT && !bidWinT && !signT) return '时间数据不完整';
    if (bidStartT && entryT < bidStartT) return '未招标进场';
    if (bidWinT && entryT < bidWinT) return '未定标进场';
    if (signT && entryT < signT) return '未签合同进场';
    return '无问题';
  }

  /** 列配置（默认全部显示，hidden 列默认隐藏） */
  async columns() {
    let config: Record<string, boolean> = {};
    try {
      config = JSON.parse((await this.sysParam.get('ledger.columns.config', '{}')) || '{}');
    } catch {
      config = {};
    }
    return LEDGER_COLUMNS.map((c) => ({
      key: c.key,
      title: c.title,
      width: c.width || 16,
      visible: config[c.key] !== undefined ? config[c.key] : !c.defaultHidden,
    }));
  }

  async saveColumns(config: Record<string, boolean>) {
    await this.sysParam.set('ledger.columns.config', JSON.stringify(config), '合同台账列显隐配置');
    return this.columns();
  }

  async summary(projectId: string) {
    const res = await this.findAll({ pageSize: 2000 }, projectId, IMPORT_MAX_ROWS);
    const list = res.list as any[];
    const sumBy = (key: string) => list.reduce((s, r) => s + (Number(r[key]) || 0), 0);
    return {
      contractCount: list.length,
      contractAmount: Number(sumBy('amount').toFixed(2)),
      settleAmount: Number(sumBy('cumSettleAmount').toFixed(2)),
      invoiceAmount: Number(sumBy('cumInvoiceAmount').toFixed(2)),
      paidAmount: Number(sumBy('cumPaidAmount').toFixed(2)),
      payableAmount: Number(sumBy('payableAmount').toFixed(2)),
      debt100: Number(sumBy('debt100').toFixed(2)),
      complianceIssues: list.filter((r) => r.compliance && r.compliance !== '无问题').length,
    };
  }

  async export(projectId: string) {
    const res = await this.findAll({ pageSize: 5000 }, projectId, IMPORT_MAX_ROWS);
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const years = ['2024', '2025', '2026'];
    const rows = (res.list as any[]).map((r) => ({
      ...r,
      settleRatioPct: r.settleRatio !== null && r.settleRatio !== undefined ? r.settleRatio / 100 : null,
      paidRatioPct: r.paidRatio !== null && r.paidRatio !== undefined ? r.paidRatio / 100 : null,
      ...Object.fromEntries(years.map((y) => [`yearSettle${y}`, (r.yearSettle || {})[y] ?? null])),
      ...Object.fromEntries(years.map((y) => [`yearPaid${y}`, (r.yearPaid || {})[y] ?? null])),
    }));
    const buffer = await this.styled.exportTable({
      sheetName: '合同台账',
      logoColumn: true,
      title: `合同台账（${project?.name || ''}）`,
      columns: [
        { header: '序号', key: 'index', width: 60, type: 'int' },
        { header: '合同编号', key: 'contractCode', width: 260 },
        { header: '财务一体化合同编号', key: 'financeCode', width: 150 },
        { header: '供应单位', key: 'supplierName', width: 180 },
        { header: '供应材料', key: 'materialNames', width: 180 },
        { header: '采购来源', key: 'procurementSource', width: 140, type: 'center' },
        { header: '是否厂家直采', key: 'isDirectPurchase', width: 110, type: 'center' },
        { header: '合同名称', key: 'contractName', width: 240 },
        { header: '招标名称', key: 'bidName', width: 160 },
        { header: '合同执行情况', key: 'execStatus', width: 110, type: 'center' },
        { header: '分供方类别', key: 'supplierCategory', width: 100, type: 'center' },
        { header: '法人', key: 'legalPerson', width: 90, type: 'center' },
        { header: '授权人', key: 'authPerson', width: 90, type: 'center' },
        { header: '联系人', key: 'contactName', width: 90, type: 'center' },
        { header: '联系电话', key: 'contactPhone', width: 120, type: 'center' },
        { header: '合同额', key: 'amount', width: 130, type: 'money' },
        { header: '税率', key: 'taxRate', width: 70, type: 'pct' },
        { header: '当前合同付款比例', key: 'currentPayRatio', width: 140, type: 'pct' },
        { header: '合同约定付款方式', key: 'paymentMethod', width: 160, type: 'center' },
        { header: '是否补充协议', key: 'isSupplement', width: 110, type: 'center' },
        { header: '补充协议类型', key: 'supplementType', width: 120, type: 'center' },
        { header: '开始招标时间', key: 'bidStartDate', width: 110, type: 'center' },
        { header: '定标时间', key: 'bidWinDate', width: 110, type: 'center' },
        { header: '合同签订时间', key: 'signDate', width: 110, type: 'center' },
        { header: '合同交底时间', key: 'disclosureDate', width: 110, type: 'center' },
        { header: '首次进场时间', key: 'firstEntryDate', width: 110, type: 'center' },
        { header: '合规性问题', key: 'compliance', width: 140 },
        { header: '投诉情况', key: 'complaint', width: 120 },
        { header: '开累结算金额', key: 'cumSettleAmount', width: 140, type: 'money' },
        { header: '审定结算额', key: 'auditedSettleAmount', width: 140, type: 'money' },
        { header: '开累税前结算金额', key: 'cumSettleBeforeTax', width: 150, type: 'money' },
        { header: '开累进项税额', key: 'cumInputTax', width: 130, type: 'money' },
        { header: '开累发票金额', key: 'cumInvoiceAmount', width: 140, type: 'money' },
        { header: '开累付款金额', key: 'cumPaidAmount', width: 140, type: 'money' },
        { header: '应付款金额', key: 'payableAmount', width: 130, type: 'money' },
        { header: '应付未付金额', key: 'unpaidAmount', width: 130, type: 'money' },
        { header: '100%欠款', key: 'debt100', width: 130, type: 'money' },
        { header: '已结算金额占合同比例', key: 'settleRatioPct', width: 150, type: 'pct' },
        { header: '已付款金额占结算比例', key: 'paidRatioPct', width: 150, type: 'pct' },
        { header: '总结算审减额', key: 'settleReduceAmount', width: 130, type: 'money' },
        ...years.map((y) => ({ header: `${y}年结算金额`, key: `yearSettle${y}`, width: 130, type: 'money' as const })),
        ...years.map((y) => ({ header: `${y}年付款金额`, key: `yearPaid${y}`, width: 130, type: 'money' as const })),
      ],
      rows,
      totalsKeys: [
        'amount', 'cumSettleAmount', 'auditedSettleAmount', 'cumSettleBeforeTax', 'cumInputTax',
        'cumInvoiceAmount', 'cumPaidAmount', 'payableAmount', 'unpaidAmount', 'debt100', 'settleReduceAmount',
        ...years.map((y) => `yearSettle${y}`), ...years.map((y) => `yearPaid${y}`),
      ],
      totalsLabel: '汇总',
    });
    return buffer;
  }
}
