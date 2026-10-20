import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, fmtDate } from '../../common/utils/helpers';
import { deriveLedgerAmounts, isFilledNumber } from '../../common/utils/ledger-derived';
import { resolveChainAmounts, type ContractChainRow } from '../../common/utils/contract-chain';
import { paidPaymentWhere } from '../../constants/statuses';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { calcLedgerCompliance } from './ledger-compliance';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { LEDGER_COLUMNS, ledgerColumnWidthPx } from './ledger-columns';

// 列定义与列宽换算已抽到 ./ledger-columns（零依赖，可单测）；此处再导出以兼容既有引用
export { LEDGER_COLUMNS, ledgerColumnWidthPx };


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

    /**
     * 合规性（compliance）是**内存派生列**（由合同类型/进场/中标/签订日期算出来），
     * 数据库里没有这一列，无法进 SQL 的 where。若先 skip/take 再内存过滤，
     * 当页可能只剩几行甚至 0 行、而 total 仍是未过滤的总数——分页与"共 N 条"全错。
     * 故有该筛选时取全量、过滤后再切片；无筛选仍走数据库分页。
     */
    const complianceFilter = query.compliance ? String(query.compliance) : '';

    let [contracts, total] = await Promise.all([
      this.prisma.contract.findMany({
        where, ...(complianceFilter ? {} : { skip, take }), orderBy: { createdAt: 'desc' },
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
      // 排除"不构成实际出资"的状态（付款失败/已退款）——与防超付闸门用**同一份**清单，
      // 否则同一笔失败付款会在闸门里被排除、在台账里被算入，两处给出相反结论
      this.prisma.paymentRecord.findMany({
        where: {
          contractId: { in: contractIds },
          ...paidPaymentWhere(),
        },
        select: { contractId: true, payMonth: true, amount: true },
      }),
    ]);

    const groupBy = (list: any[], key: string) =>
      list.reduce((acc: any, i: any) => {
        (acc[i[key]] = acc[i[key]] || []).push(i);
        return acc;
      }, {});

    /**
     * 合同链（业务口径 2026-10-15：**合同当前金额 = 主合同 + Σ 补充协议 changeAmount**）。
     * 一次取项目内全部合同的四个字段后在内存算链；本页只展示 500 行，但链的成员可能不在本页，
     * 故这里按项目取全（合同条数与台账行数同量级，可接受），避免逐行查库退化成 N+1。
     */
    const chainRows: ContractChainRow[] = await this.prisma.contract.findMany({
      where: { projectId },
      select: { id: true, parentContractId: true, amount: true, changeAmount: true },
    });

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
      /** 合同额：未填（NULL/空串）时留 `null`，**不要**当成 0 —— 见 ledger-derived.ts 的口径说明 */
      const amountFilled = c.amount !== null && c.amount !== undefined && c.amount !== '';
      const amount = amountFilled ? num(c.amount) : null;

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

      /**
       * 合同当前金额（链口径）。补充协议行显示与其主合同**同一个数**——
       * 它描述的是"这条链现在值多少钱"，比例与欠款都按它算。
       */
      const chain = resolveChainAmounts(chainRows, c.id);
      const currentAmount = chain.currentAmount;

      const compliance = calcLedgerCompliance(c.typeCode, firstEntryDate, ext.bidStartDate, ext.bidWinDate, c.signDate);

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
        amount, // 本行合同额；null = 未填（前端显示 '-'、导出留白）
        currentAmount, // 合同当前金额（链口径）：比例与欠款的分母
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
        // 派生金额列统一走单一实现（口径见 common/utils/ledger-derived.ts）：
        // 合同额未填 → 相关列留空，而不是算成 0 / 负数
        ...deriveLedgerAmounts({
          // ⚠️ 传的是**合同当前金额**（链口径）而不是本行合同额：
          // 业务口径「已结算金额占合同比例 = 已结算 ÷ 合同当前金额」（2026-10-15 澄清）
          amount: currentAmount,
          cumSettleAmount,
          cumPaidAmount,
          auditedSettleAmount,
          payRatio: ext.currentPayRatio,
        }),
        settleReduceAmount: Number((auditedSettleAmount - cumSettleAmount).toFixed(2)),
        yearSettle,
        yearPaid,
      };
    });

    if (complianceFilter) {
      rows = rows.filter((r: any) => r.compliance === complianceFilter);
      // 过滤后 total 必须是过滤后的条数，否则前端分页器按"未过滤总数"渲染出空页
      total = rows.length;
      rows = rows.slice(skip, skip + take).map((r: any, i: number) => ({ ...r, index: skip + i + 1 }));
    }

    return { ...buildResult(rows, total, query), columns: await this.columns() };
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
      // 对外暴露的是**像素**宽（见 LEDGER_COLUMNS 注释）：由 Excel 字符宽统一换算，
      // 前端直接当 antd 列宽使用，勿再改回原始字符值
      width: ledgerColumnWidthPx(c.width),
      visible: config[c.key] !== undefined ? config[c.key] : !c.defaultHidden,
    }));
  }

  async saveColumns(config: Record<string, boolean>) {
    await this.sysParam.set('ledger.columns.config', JSON.stringify(config), '合同台账列显隐配置');
    return this.columns();
  }

  /**
   * 汇总与导出要的是**全量**台账行。不能 `findAll({ pageSize: 2000/5000 })` 一把梭：
   * `paginate` 会把 take 夹到单页上限（500），合同数超过上限时统计卡片与导出文件都静默少算/少行。
   * 这里按页拉到底（页数上限 1000 是保险丝，正常不会触到）。
   */
  private async allRows(projectId: string): Promise<any[]> {
    const pageSize = 500;
    const out: any[] = [];
    for (let page = 1; page <= 1000; page += 1) {
      const res: any = await this.findAll({ page, pageSize }, projectId, pageSize);
      const batch = (res.list || []) as any[];
      out.push(...batch);
      if (!batch.length || out.length >= Number(res.total ?? 0)) break;
    }
    return out;
  }

  async summary(projectId: string) {
    const list = await this.allRows(projectId);
    const sumBy = (key: string) => list.reduce((s, r) => s + (Number(r[key]) || 0), 0);
    return {
      contractCount: list.length,
      /**
       * 未填合同额的条数：汇总卡片里的金额是"**已知部分的合计**"，
       * 未填金额的合同按 0 参与求和（合同额未知，无从计入）。
       * 不把这件事说出来的话，总额会看起来是完整的——前端据此显示"另有 N 份未填金额"。
       * 口径见 common/utils/ledger-derived.ts。
       */
      // 复用同一口径的判定（显式填 0 不算"未填"）
      amountMissingCount: list.filter((r) => !isFilledNumber(r.amount)).length,
      contractAmount: Number(sumBy('amount').toFixed(2)),
      settleAmount: Number(sumBy('cumSettleAmount').toFixed(2)),
      invoiceAmount: Number(sumBy('cumInvoiceAmount').toFixed(2)),
      paidAmount: Number(sumBy('cumPaidAmount').toFixed(2)),
      payableAmount: Number(sumBy('payableAmount').toFixed(2)),
      debt100: Number(sumBy('debt100').toFixed(2)),
      complianceIssues: list.filter((r) => r.compliance && r.compliance !== '无问题').length,
    };
  }

  /**
   * 导出用的年度列：近三年（保留原有默认视图）+ 行内实际出现过的结算/付款年份 + 合同签订/首次进场年。
   * 写死 ['2024','2025','2026'] 会让 2027 年及以后的结算/付款在导出里整列丢失，
   * 而页面列表用的是行内 yearSettle/yearPaid 实时算的，导出必须与页面同口径。
   */
  private exportYears(rows: any[]): string[] {
    const nowYear = new Date().getFullYear();
    const set = new Set<string>();
    for (let y = nowYear - 2; y <= nowYear; y += 1) set.add(String(y));
    const addYear = (v: any) => {
      if (!v) return;
      if (v instanceof Date) {
        if (!Number.isNaN(v.getTime())) set.add(String(v.getFullYear()));
        return;
      }
      const m = String(v).match(/^(\d{4})/);
      if (m) set.add(m[1]);
    };
    for (const r of rows) {
      for (const y of Object.keys(r.yearSettle || {})) if (/^\d{4}$/.test(y)) set.add(y);
      for (const y of Object.keys(r.yearPaid || {})) if (/^\d{4}$/.test(y)) set.add(y);
      addYear(r.signDate);
      addYear(r.firstEntryDate);
    }
    return [...set].sort();
  }

  async export(projectId: string) {
    const list = await this.allRows(projectId);
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const years = this.exportYears(list);
    const rows = list.map((r) => ({
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
        { header: '合同当前金额', key: 'currentAmount', width: 130, type: 'money' },
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
