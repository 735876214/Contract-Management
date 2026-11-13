import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { round2, round4 } from '../../../common/utils/money';
import { resolveChainAmounts, notDraft } from '../../../common/utils/contract-chain';
import {
  CONTRACT_EXECUTION_STATUS,
  CONTRACT_STATUS,
  LEGACY_CONTRACT_STATUS_COMPLETED,
  SITE_CONFIRM_STATUS,
  countedInvoiceWhere,
  paidPaymentWhere,
} from '../../../constants/statuses';
import { deriveContractFulfillment } from '../../../common/utils/contract-fulfillment';
import { summarizeAssetFlow } from '../../../common/utils/asset-flow';
import { SysParamService } from '../../../common/services/sys-param.service';
import { indexContractRows, resolveChainRoot } from '../common/contract-roots';
import { datasetColumnsOf } from './dataset-columns';
import { inRange, localDayKey, localMonthKey, type DayRange } from '../common/period';
import type {
  AiAnalyticsProjectFact,
  AiAnalyticsTotals,
  AiCollectedDataset,
} from './analytics.types';

/** 单数据集明细上限（与计划 §2.4 一致） */
const MAX_ROWS = 5000;

export interface CollectedAnalytics {
  datasets: AiCollectedDataset[];
  totals: AiAnalyticsTotals;
  compareTotals: AiAnalyticsTotals | null;
  byProject: AiAnalyticsProjectFact[];
  warnings: string[];
  asOf: string;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const monthBetween = (range: DayRange): { gte: string; lte: string } | null =>
  range.from ? { gte: localMonthKey(range.from), lte: localMonthKey(range.to) } : null;

const isSigned = (c: { status?: string | null }): boolean => {
  const s = String(c.status ?? '');
  return s === CONTRACT_STATUS.SIGNED || s === LEGACY_CONTRACT_STATUS_COMPLETED;
};

const ds = (
  key: string,
  rows: Array<Record<string, string | number | null>>,
  summary: string,
): AiCollectedDataset => {
  const total = rows.length;
  const capped = rows.slice(0, MAX_ROWS);
  return {
    key,
    // 列定义以 `dataset-columns.ts` 为单一事实源（工作簿/行级填充/前端映射共用）
    columns: [...datasetColumnsOf(key)],
    rows: capped,
    totalRows: total,
    truncated: total > capped.length,
    summary,
  };
};

/**
 * AI 经营数据助手 · 数据集采集器（Phase 2）。
 *
 * 只读、按项目收口、显式带 `projectId`；金额口径复用既有纯函数/常量：
 * 合同链（`resolveChainAmounts`）、排除草稿（`notDraft`）、有效付款（`paidPaymentWhere`）、
 * 有效发票（`countedInvoiceWhere`）、履约派生（`deriveContractFulfillment`）、进出场（`summarizeAssetFlow`）。
 */
@Injectable()
export class DatasetCollector {
  constructor(
    private prisma: PrismaClient,
    private sysParam: SysParamService,
  ) {}

  private async requireConfirmed(): Promise<boolean> {
    const v = await this.sysParam.get('settlement.require_confirmed', 'true');
    return String(v).toLowerCase() !== 'false';
  }

  /** 当前期间的核心指标（逐项目 → 汇总；与对比期完全同口径） */
  private async projectCore(
    projects: Array<{ id: string; code: string; name: string }>,
    range: DayRange,
  ): Promise<AiAnalyticsProjectFact[]> {
    const ids = projects.map((p) => p.id);
    const gated = await this.requireConfirmed();
    const [contracts, settlements, payments, invoices, daily, tasks] = await Promise.all([
      this.prisma.contract.findMany({
        where: { projectId: { in: ids } },
        select: { id: true, projectId: true, parentContractId: true, amount: true, changeAmount: true, signDate: true, status: true },
      }),
      this.prisma.settlement.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { settleDate: { gte: range.from, lte: range.to } } : {}), ...notDraft },
        select: { projectId: true, amount: true, actualAmount: true },
      }),
      this.prisma.paymentRecord.findMany({
        where: {
          projectId: { in: ids },
          AND: [
            paidPaymentWhere(),
            ...(range.from
              ? [{ OR: [{ payDate: { gte: range.from, lte: range.to } }, { payDate: null, payMonth: monthBetween(range) ?? undefined }] }]
              : []),
          ],
        },
        select: { projectId: true, amount: true },
      }),
      this.prisma.invoice.findMany({
        where: { projectId: { in: ids }, ...countedInvoiceWhere(), ...(range.from ? { invoiceDate: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, amountWithTax: true },
      }),
      this.prisma.dailyReport.groupBy({
        by: ['projectId'],
        where: {
          projectId: { in: ids },
          ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}),
          ...(range.from ? { entryDate: { gte: range.from, lte: range.to } } : {}),
        },
        _count: { _all: true },
      }),
      this.prisma.procurementTask.groupBy({
        by: ['projectId'],
        where: { projectId: { in: ids }, ...(range.from ? { createdAt: { gte: range.from, lte: range.to } } : {}) },
        _count: { _all: true },
      }),
    ]);

    const map = new Map<string, AiAnalyticsProjectFact>();
    for (const p of projects) {
      map.set(p.id, {
        projectId: p.id,
        code: p.code,
        name: p.name,
        contractCount: 0,
        signedYuan: 0,
        settledYuan: 0,
        paidYuan: 0,
        invoicedYuan: 0,
        unpaidYuan: 0,
        uninvoicedYuan: 0,
        dailyReports: 0,
        procurementTasks: 0,
      });
    }
    for (const c of contracts) {
      if (!isSigned(c) || !inRange(c.signDate, range)) continue;
      const row = map.get(c.projectId);
      if (!row) continue;
      row.contractCount += 1;
      row.signedYuan = round2(row.signedYuan + Number((c.parentContractId ? c.changeAmount : c.amount) ?? 0));
    }
    for (const s of settlements) {
      const row = map.get(s.projectId);
      if (row) row.settledYuan = round2(row.settledYuan + Number(s.actualAmount ?? s.amount ?? 0));
    }
    for (const p of payments) {
      const row = map.get(p.projectId);
      if (row) row.paidYuan = round2(row.paidYuan + Number(p.amount ?? 0));
    }
    for (const i of invoices) {
      const row = map.get(i.projectId);
      if (row) row.invoicedYuan = round2(row.invoicedYuan + Number(i.amountWithTax ?? 0));
    }
    for (const d of daily) {
      const row = map.get(d.projectId);
      if (row) row.dailyReports = d._count._all;
    }
    for (const t of tasks) {
      const row = map.get(t.projectId);
      if (row) row.procurementTasks = t._count._all;
    }
    const list = [...map.values()];
    for (const row of list) {
      row.unpaidYuan = round2(row.settledYuan - row.paidYuan);
      row.uninvoicedYuan = round2(row.settledYuan - row.invoicedYuan);
    }
    return list;
  }

  private sumTotals(byProject: AiAnalyticsProjectFact[]): AiAnalyticsTotals {
    const t: AiAnalyticsTotals = {
      projectCount: byProject.length,
      contractCount: 0,
      signedYuan: 0,
      settledYuan: 0,
      paidYuan: 0,
      invoicedYuan: 0,
      unpaidYuan: 0,
      uninvoicedYuan: 0,
      dailyReports: 0,
      procurementTasks: 0,
    };
    for (const p of byProject) {
      t.contractCount += p.contractCount;
      t.signedYuan = round2(t.signedYuan + p.signedYuan);
      t.settledYuan = round2(t.settledYuan + p.settledYuan);
      t.paidYuan = round2(t.paidYuan + p.paidYuan);
      t.invoicedYuan = round2(t.invoicedYuan + p.invoicedYuan);
      t.dailyReports += p.dailyReports;
      t.procurementTasks += p.procurementTasks;
    }
    t.unpaidYuan = round2(t.settledYuan - t.paidYuan);
    t.uninvoicedYuan = round2(t.settledYuan - t.invoicedYuan);
    return t;
  }

  /** 供填报取值复用：项目集合 × 期间的窗口口径（与报告同一实现） */
  async windowTotals(
    projects: Array<{ id: string; code: string; name: string }>,
    range: DayRange,
  ): Promise<AiAnalyticsTotals> {
    return this.sumTotals(await this.projectCore(projects, range));
  }

  async collect(
    projects: Array<{ id: string; code: string; name: string }>,
    range: DayRange,
    compare: DayRange | null,
    selectedKeys?: readonly string[],
  ): Promise<CollectedAnalytics> {
    const ids = projects.map((p) => p.id);
    const monthRange = monthBetween(range);
    const gated = await this.requireConfirmed();

    // 按所选数据集裁剪查询：核心汇总（合同/结算/付款/发票/日报）始终需要；明细查询按需执行。
    const wanted = selectedKeys?.length ? new Set(selectedKeys) : null;
    const need = (...keys: string[]): boolean => !wanted || keys.some((k) => wanted.has(k));
    const q = (keys: string[], fn: () => Promise<any[]>): Promise<any[]> =>
      need(...keys) ? fn() : Promise.resolve([]);

    const [
      projectsRows,
      contracts,
      settlements,
      payments,
      invoices,
      dailyGroups,
      ledgerRows,
      tasks,
      bidders,
      receipts,
      profitLosses,
      laborDocs,
      factoring,
      overdue,
      assets,
      materials,
      dailyAll,
      settlementsAll,
      paymentsAll,
      invoicesAll,
      repayments,
      finalSettlements,
      paymentProcedures,
      changeLogs,
      materialBases,
      contractMaterials,
      laborAuths,
      procurementDocs,
      inspections,
    ] = await Promise.all([
      this.prisma.project.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, name: true, nameAbbr: true, projectManager: true, startDate: true, endDate: true },
      }),
      this.prisma.contract.findMany({
        where: { projectId: { in: ids } },
        select: {
          id: true,
          projectId: true,
          code: true,
          name: true,
          supplierId: true,
          parentContractId: true,
          amount: true,
          changeAmount: true,
          signDate: true,
          status: true,
          execStatus: true,
          supplier: { select: { name: true } },
        },
        take: 20000,
      }),
      q(["settlement.summary","settlement.detail"], () => this.prisma.settlement.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { settleDate: { gte: range.from, lte: range.to } } : {}), ...notDraft },
        select: { projectId: true, contractId: true, code: true, amount: true, actualAmount: true, settleDate: true, statusCode: true, contract: { select: { code: true } } },
        take: MAX_ROWS,
      })),
      q(["payment.records"], () => this.prisma.paymentRecord.findMany({
        where: {
          projectId: { in: ids },
          AND: [
            paidPaymentWhere(),
            ...(range.from
              ? [{ OR: [{ payDate: { gte: range.from, lte: range.to } }, { payDate: null, payMonth: monthRange ?? undefined }] }]
              : []),
          ],
        },
        select: { projectId: true, contractId: true, amount: true, payDate: true, payMonth: true, statusCode: true, contract: { select: { code: true } } },
        take: MAX_ROWS,
      })),
      q(["invoice.records"], () => this.prisma.invoice.findMany({
        where: { projectId: { in: ids }, ...countedInvoiceWhere(), ...(range.from ? { invoiceDate: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, contractId: true, amountWithTax: true, invoiceDate: true, statusCode: true, contract: { select: { code: true } } },
        take: MAX_ROWS,
      })),
      q(["daily.report"], () => (this.prisma.dailyReport.groupBy as any)({
        by: ['projectId'],
        where: {
          projectId: { in: ids },
          ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}),
          ...(range.from ? { entryDate: { gte: range.from, lte: range.to } } : {}),
        },
        _count: { _all: true },
        _sum: { settleQty: true, amountAfterTax: true },
      })),
      q(["settlement.ledger"], () => this.prisma.settlementLedger.findMany({
        where: { projectId: { in: ids }, ...(monthRange ? { settleMonth: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
        select: {
          projectId: true,
          settleMonth: true,
          monthSettleAmount: true,
          monthInvoiceAmount: true,
          factoringDiscount: true,
          overdueInterest: true,
          contract: { select: { code: true } },
        },
        take: MAX_ROWS,
      })),
      q(["procurement.task"], () => this.prisma.procurementTask.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { createdAt: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, taskNo: true, type: true, status: true },
        take: MAX_ROWS,
      })),
      q(["procurement.result"], () => this.prisma.procurementBidder.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { task: { createdAt: { gte: range.from, lte: range.to } } } : {}) },
        select: { projectId: true, bidderName: true, status: true, finalPreTaxTotal: true, task: { select: { taskNo: true } } },
        take: MAX_ROWS,
      })),
      q(["receipt.order"], () => this.prisma.receiptOrder.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { orderDate: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, orderNo: true, orderDate: true, supplierName: true, status: true, _count: { select: { details: true } } },
        take: MAX_ROWS,
      })),
      q(["cost.profit_loss"], () => this.prisma.monthlyProfitLoss.findMany({
        where: { projectId: { in: ids }, ...(monthRange ? { period: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
        select: { projectId: true, period: true, sixSavingsAmount: true, totalDeductAmount: true, _count: { select: { details: true } } },
        take: MAX_ROWS,
      })),
      q(["cost.labor_receiving","labor.receiving_doc"], () => this.prisma.laborReceivingDoc.findMany({
        where: { projectId: { in: ids }, ...(monthRange ? { period: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
        select: { projectId: true, docNo: true, subcontractorName: true, period: true, status: true, _count: { select: { details: true } } },
        take: MAX_ROWS,
      })),
      q(["finance.cost"], () => this.prisma.factoringCost.findMany({
        where: { contract: { projectId: { in: ids } }, ...(range.from ? { financingDate: { gte: range.from, lte: range.to } } : {}) },
        select: { financingDate: true, totalCost: true, settlementMonth: true, contract: { select: { code: true, projectId: true } } },
        take: MAX_ROWS,
      })),
      q(["finance.cost"], () => this.prisma.overdueInterest.findMany({
        where: { contract: { projectId: { in: ids } }, ...(monthRange ? { settlementMonth: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
        select: { settlementMonth: true, overdueInterest: true, contract: { select: { code: true, projectId: true } } },
        take: MAX_ROWS,
      })),
      q(["asset.flow"], () => this.prisma.assetLedger.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { date: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, sourceCode: true, qty: true, totalAmount: true },
        take: MAX_ROWS,
      })),
      q(["contract.fulfillment"], () => this.prisma.contractMaterial.findMany({
        where: { contract: { projectId: { in: ids } } },
        select: { qty: true, contract: { select: { projectId: true } } },
        take: 20000,
      })),
      q(["contract.fulfillment"], () => (this.prisma.dailyReport.groupBy as any)({
        by: ['projectId'],
        where: { projectId: { in: ids }, ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}) },
        _sum: { settleQty: true },
      })),
      q(["contract.fulfillment"], () => this.prisma.settlement.findMany({
        where: { projectId: { in: ids }, ...notDraft },
        select: { projectId: true, amount: true, actualAmount: true },
      })),
      q(["contract.fulfillment"], () => (this.prisma.paymentRecord.groupBy as any)({
        by: ['projectId'],
        where: { projectId: { in: ids }, ...paidPaymentWhere() },
        _sum: { amount: true },
      })),
      q(["contract.fulfillment"], () => (this.prisma.invoice.groupBy as any)({
        by: ['projectId'],
        where: { projectId: { in: ids }, ...countedInvoiceWhere() },
        _sum: { amountWithTax: true },
      })),
      q(["repayment.agreement"], () => this.prisma.repaymentAgreement.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { signDate: { gte: range.from, lte: range.to } } : {}) },
        select: {
          projectId: true,
          code: true,
          material: true,
          signDate: true,
          settleAmount: true,
          agreedDebtAmount: true,
          paidBeforeSign: true,
          paidAfterSign: true,
          overdueUnpaid: true,
          supplier: { select: { name: true } },
          contract: { select: { code: true } },
        },
        take: MAX_ROWS,
      })),
      q(["final_settlement.summary"], () => this.prisma.finalSettlement.findMany({
        where: { projectId: { in: ids } },
        select: { projectId: true, code: true, statusCode: true, totalAmount: true, settledAt: true, createdAt: true, contract: { select: { code: true } } },
        take: MAX_ROWS,
      })),
      q(["payment_procedure.records"], () => this.prisma.paymentProcedure.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { createdAt: { gte: range.from, lte: range.to } } : {}) },
        select: {
          projectId: true,
          code: true,
          settleCumAmount: true,
          paidCumAmount: true,
          unpaidAmount: true,
          payDate: true,
          statusCode: true,
          supplier: { select: { name: true } },
          contract: { select: { code: true } },
        },
        take: MAX_ROWS,
      })),
      q(["contract.change_log"], () => this.prisma.contractChangeLog.findMany({
        where: { contract: { projectId: { in: ids } }, ...(range.from ? { createdAt: { gte: range.from, lte: range.to } } : {}) },
        select: {
          field: true,
          fieldLabel: true,
          beforeValue: true,
          afterValue: true,
          operator: true,
          createdAt: true,
          contract: { select: { code: true, projectId: true } },
        },
        take: MAX_ROWS,
      })),
      q(["material.base"], () => this.prisma.materialBase.findMany({
        select: { name: true, spec: true, categoryLevel1: true, categoryLevel2: true, unit: true, isAsset: true, status: true },
        take: MAX_ROWS,
      })),
      q(["material.contract"], () => this.prisma.contractMaterial.findMany({
        where: { contract: { projectId: { in: ids } } },
        select: {
          qty: true,
          priceBeforeTax: true,
          priceWithTax: true,
          totalWithTax: true,
          incomePrice: true,
          stdPrice: true,
          contract: { select: { code: true, projectId: true } },
          materialBase: { select: { name: true, spec: true } },
        },
        take: MAX_ROWS,
      })),
      q(["labor.auth"], () => this.prisma.laborAuthLedger.findMany({
        where: { projectId: { in: ids } },
        select: {
          projectId: true,
          subcontractorName: true,
          legalPerson: true,
          authorizedPerson: true,
          authStartDate: true,
          authEndDate: true,
          status: true,
        },
        take: MAX_ROWS,
      })),
      q(["procurement.documents"], () => this.prisma.procurementTask.findMany({
        where: { projectId: { in: ids } },
        select: {
          projectId: true,
          taskNo: true,
          type: true,
          createdAt: true,
          procurementNotice: { select: { procurementTime: true, publishedAt: true, createdAt: true } },
          procurementDocument: { select: { procurementTime: true, publishedAt: true, createdAt: true } },
          procurementPriceCompare: { select: { publishedAt: true, createdAt: true } },
          preMeetingMinutes: { select: { meetingTime: true, createdAt: true } },
          frameworkExplanation: { select: { publishedAt: true, createdAt: true } },
          procurementResultReport: { select: { openTime: true, publishedAt: true, createdAt: true } },
          evaluations: { select: { evaluatedAt: true, evaluator: true, conclusion: true }, take: 20 },
        },
        take: MAX_ROWS,
      })),
      q(["procurement.documents"], () => this.prisma.inspectionReport.findMany({
        where: { projectId: { in: ids } },
        select: { projectId: true, unitName: true, inspectionTime: true, publishedAt: true, createdAt: true },
        take: MAX_ROWS,
      })),
    ]);

    const warnings: string[] = [];
    const projectLabel = new Map<string, string>(projectsRows.map((p) => [String(p.id), `${p.code} ${p.name}`]));

    // ---- 合同链：链根当前金额（全部合同行参与解析，不能只看已签行） ----
    const chainIndex = indexContractRows(contracts);
    const rootAmount = new Map<string, number | null>();
    for (const c of contracts) {
      if (c.parentContractId) continue;
      const r = resolveChainAmounts(contracts as any, c.id);
      rootAmount.set(c.id, r.currentAmount === null || r.currentAmount === undefined ? null : Number(r.currentAmount));
    }
    const chainAmountOf = (contractId: string): number | null => {
      const root = resolveChainRoot(chainIndex, contractId);
      return root.broken ? null : rootAmount.get(root.rootId) ?? null;
    };
    const chainSumByProject = new Map<string, { sum: number; hasUnknown: boolean }>();
    for (const c of contracts) {
      if (c.parentContractId) continue;
      // 签约额只算**已签**链（与 scm-facts / 台账「已签合同」同口径；草稿/审批中不是承诺）
      if (!isSigned(c)) continue;
      const hit = chainSumByProject.get(c.projectId) ?? { sum: 0, hasUnknown: false };
      const v = rootAmount.get(c.id);
      if (v === null || v === undefined) hit.hasUnknown = true;
      else hit.sum = round2(hit.sum + v);
      chainSumByProject.set(c.projectId, hit);
    }

    // ---- 核心指标（当前期间）----
    const byProject = await this.projectCore(projects, range);
    const totals = this.sumTotals(byProject);
    const compareTotals = compare ? this.sumTotals(await this.projectCore(projects, compare)) : null;

    // ---- 履约（累计口径）----
    const materialQtyByProject = new Map<string, { sum: number; hasUnknown: boolean }>();
    for (const m of materials) {
      const pid = m.contract.projectId;
      const hit = materialQtyByProject.get(pid) ?? { sum: 0, hasUnknown: false };
      const q = num(m.qty);
      if (q == null) hit.hasUnknown = true;
      else hit.sum += q;
      materialQtyByProject.set(pid, hit);
    }
    const settledAllByProject = new Map<string, number>();
    for (const s of settlementsAll) {
      settledAllByProject.set(s.projectId, round2((settledAllByProject.get(s.projectId) ?? 0) + Number(s.actualAmount ?? s.amount ?? 0)));
    }
    const dailyAllByProject = new Map<string, number>(
      dailyAll.map((d) => [String(d.projectId), round4(num(d._sum.settleQty) ?? 0)]),
    );
    const paidAllByProject = new Map<string, number>(
      paymentsAll.map((p) => [String(p.projectId), round2(num(p._sum.amount) ?? 0)]),
    );
    const invoicedAllByProject = new Map<string, number>(
      invoicesAll.map((i) => [String(i.projectId), round2(num(i._sum.amountWithTax) ?? 0)]),
    );

    // ---- 数据集 ----
    const datasets: AiCollectedDataset[] = [];
    const orderedProjects = [...projectsRows].sort((a, b) => a.code.localeCompare(b.code));

    datasets.push(
      ds(
        'project.base',
        orderedProjects.map((p) => ({
          项目: `${p.code} ${p.name}`,
          简称: p.nameAbbr ?? '',
          项目经理: p.projectManager ?? '',
          开始日期: p.startDate ? localDayKey(p.startDate) : null,
          结束日期: p.endDate ? localDayKey(p.endDate) : null,
        })),
        `共 ${orderedProjects.length} 个项目`),
    );

    const signed = contracts.filter((c) => c.status === CONTRACT_STATUS.SIGNED || c.status === LEGACY_CONTRACT_STATUS_COMPLETED);
    const periodSigned = signed.filter((c) => inRange(c.signDate, range));
    const summaryRows = orderedProjects.map((p) => {
      const rows = periodSigned.filter((c) => c.projectId === p.id);
      const chain = chainSumByProject.get(p.id);
      return {
        项目: `${p.code} ${p.name}`,
        本期新签合同: rows.length,
        本期新签金额: round2(rows.reduce((s, c) => s + Number((c.parentContractId ? c.changeAmount : c.amount) ?? 0), 0)),
        链金额合计: chain ? (chain.hasUnknown ? null : chain.sum) : null,
        执行中合同: contracts.filter((c) => c.projectId === p.id && c.execStatus === CONTRACT_EXECUTION_STATUS.EXECUTING).length,
      };
    });
    datasets.push(
      ds(
        'contract.summary',
        summaryRows,
        `本期新签 ${periodSigned.length} 份，金额 ${fmtYuan(periodSigned.reduce((s, c) => s + Number((c.parentContractId ? c.changeAmount : c.amount) ?? 0), 0))} 元（链金额合计含存量合同）`),
    );
    datasets.push(
      ds(
        'contract.detail',
        periodSigned.map((c) => ({
          项目: projectLabel.get(c.projectId) ?? '',
          合同编号: c.code,
          合同名称: c.name,
          供应商: c.supplier?.name ?? '',
          签约日期: c.signDate ? localDayKey(c.signDate) : null,
          链当前金额: chainAmountOf(c.id),
          执行状态: c.execStatus ?? '',
        })),
        `本期新签合同 ${periodSigned.length} 份`),
    );

    const settlementRows = settlements;
    datasets.push(
      ds(
        'settlement.summary',
        orderedProjects.map((p) => {
          const rows = settlementRows.filter((s) => s.projectId === p.id);
          return {
            项目: `${p.code} ${p.name}`,
            结算单数: rows.length,
            结算金额: round2(rows.reduce((s, r) => s + Number(r.actualAmount ?? r.amount ?? 0), 0)),
          };
        }),
        `本期结算 ${settlementRows.length} 张，金额 ${fmtYuan(settlementRows.reduce((s, r) => s + Number(r.actualAmount ?? r.amount ?? 0), 0))} 元（已排除草稿）`),
    );
    datasets.push(
      ds(
        'settlement.detail',
        settlementRows.map((s) => ({
          项目: projectLabel.get(s.projectId) ?? '',
          合同编号: s.contract?.code ?? '',
          单据编号: s.code ?? '',
          结算日期: s.settleDate ? localDayKey(s.settleDate) : null,
          结算金额: round2(Number(s.actualAmount ?? s.amount ?? 0)),
          状态: s.statusCode ?? '',
        })),
        `本期结算单 ${settlementRows.length} 张`),
    );
    datasets.push(
      ds(
        'settlement.ledger',
        ledgerRows.map((l) => ({
          项目: projectLabel.get(l.projectId) ?? '',
          合同编号: l.contract?.code ?? '',
          结算月份: l.settleMonth ?? '',
          本月结算额: l.monthSettleAmount === null ? null : round2(Number(l.monthSettleAmount)),
          本月开票额: l.monthInvoiceAmount === null ? null : round2(Number(l.monthInvoiceAmount)),
          保理贴息: l.factoringDiscount === null ? null : round2(Number(l.factoringDiscount)),
          逾期利息: l.overdueInterest === null ? null : round2(Number(l.overdueInterest)),
        })),
        `台账 ${ledgerRows.length} 行`),
    );
    datasets.push(
      ds(
        'payment.records',
        payments.map((p) => ({
          项目: projectLabel.get(p.projectId) ?? '',
          合同编号: p.contract?.code ?? '',
          付款日: p.payDate ? localDayKey(p.payDate) : null,
          付款月份: p.payMonth ?? '',
          金额: round2(Number(p.amount ?? 0)),
          状态: p.statusCode ?? '',
        })),
        `本期付款 ${payments.length} 笔，金额 ${fmtYuan(payments.reduce((s, p) => s + Number(p.amount ?? 0), 0))} 元（排除失败/退款）`),
    );
    datasets.push(
      ds(
        'invoice.records',
        invoices.map((i) => ({
          项目: projectLabel.get(i.projectId) ?? '',
          合同编号: i.contract?.code ?? '',
          开票日期: i.invoiceDate ? localDayKey(i.invoiceDate) : null,
          含税金额: round2(Number(i.amountWithTax ?? 0)),
          状态: i.statusCode ?? '',
        })),
        `本期开票 ${invoices.length} 张，金额 ${fmtYuan(invoices.reduce((s, i) => s + Number(i.amountWithTax ?? 0), 0))} 元（排除作废/红冲）`),
    );

    const fulfillmentRows = orderedProjects.map((p) => {
      const chain = chainSumByProject.get(p.id);
      const currentAmount = chain ? (chain.hasUnknown ? null : chain.sum) : null;
      const ordered = materialQtyByProject.get(p.id);
      const f = deriveContractFulfillment({
        currentAmount,
        orderedQty: ordered ? (ordered.hasUnknown ? null : round4(ordered.sum)) : null,
        receivedQty: dailyAllByProject.get(p.id) ?? 0,
        settledAmount: settledAllByProject.get(p.id) ?? 0,
        paidAmount: paidAllByProject.get(p.id) ?? 0,
        invoicedAmount: invoicedAllByProject.get(p.id) ?? 0,
      });
      const pct = (v: number | null): number | null => (v === null ? null : round2(v * 100));
      return {
        项目: `${p.code} ${p.name}`,
        合同当前金额: currentAmount,
        已收数量: dailyAllByProject.get(p.id) ?? 0,
        已结算: settledAllByProject.get(p.id) ?? 0,
        已付款: paidAllByProject.get(p.id) ?? 0,
        已开票: invoicedAllByProject.get(p.id) ?? 0,
        已收比例: pct(f.receivedRatio),
        已结比例: pct(f.settledRatio),
        已付占比: pct(f.paidVsSettledRatio),
        开票比例: pct(f.invoiceRatio),
      };
    });
    datasets.push(
      ds(
        'contract.fulfillment',
        fulfillmentRows,
        `履约进度为累计口径（合同金额按合同链；已收 = 总日报已确认行）`),
    );

    datasets.push(
      ds(
        'cost.profit_loss',
        profitLosses.map((r) => ({
          项目: projectLabel.get(r.projectId) ?? '',
          结算期: r.period,
          六项降本创效: r.sixSavingsAmount === null ? null : round2(Number(r.sixSavingsAmount)),
          劳务计价累计扣款: r.totalDeductAmount === null ? null : round2(Number(r.totalDeductAmount)),
          明细行数: r._count.details,
        })),
        `月度盈亏 ${profitLosses.length} 条`),
    );
    datasets.push(
      ds(
        'cost.labor_receiving',
        laborDocs.map((d) => ({
          项目: projectLabel.get(d.projectId) ?? '',
          单据编号: d.docNo,
          分包商: d.subcontractorName,
          结算期: d.period,
          状态: d.status,
          明细数: d._count.details,
        })),
        `分包领用单据 ${laborDocs.length} 张`),
    );
    datasets.push(
      ds(
        'procurement.task',
        tasks.map((t) => ({ 项目: projectLabel.get(t.projectId) ?? '', 采购编号: t.taskNo, 类型: t.type, 状态: t.status })),
        `采购任务 ${tasks.length} 个`),
    );
    datasets.push(
      ds(
        'procurement.result',
        bidders.map((b) => ({
          项目: projectLabel.get(b.projectId) ?? '',
          采购编号: b.task?.taskNo ?? '',
          投标单位: b.bidderName,
          状态: b.status,
          最终确认价: b.finalPreTaxTotal === null ? null : round2(Number(b.finalPreTaxTotal)),
        })),
        `投标/成交单位 ${bidders.length} 家`),
    );
    datasets.push(
      ds(
        'daily.report',
        dailyGroups.map((d) => ({
          项目: projectLabel.get(d.projectId) ?? '',
          日报条数: d._count._all,
          结算量合计: round4(num(d._sum.settleQty) ?? 0),
          含税金额合计: round2(num(d._sum.amountAfterTax) ?? 0),
        })),
        `本期日报 ${dailyGroups.reduce((s, d) => s + d._count._all, 0)} 条${gated ? '（只含已确认行）' : ''}`),
    );
    datasets.push(
      ds(
        'receipt.order',
        receipts.map((r) => ({
          项目: projectLabel.get(r.projectId) ?? '',
          收领单号: r.orderNo,
          日期: r.orderDate ? localDayKey(r.orderDate) : null,
          供应单位: r.supplierName ?? '',
          状态: r.status,
          明细数: r._count.details,
        })),
        `本期收领单 ${receipts.length} 张`),
    );
    const financeRows = [
      ...factoring.map((f) => ({
        类型: '保理费用',
        项目: projectLabel.get(f.contract.projectId) ?? '',
        合同编号: f.contract.code,
        期间: f.financingDate ? localDayKey(f.financingDate) : f.settlementMonth ?? '',
        金额: f.totalCost === null ? null : round2(Number(f.totalCost)),
      })),
      ...overdue.map((o) => ({
        类型: '逾期利息',
        项目: projectLabel.get(o.contract.projectId) ?? '',
        合同编号: o.contract.code,
        期间: o.settlementMonth,
        金额: o.overdueInterest === null ? null : round2(Number(o.overdueInterest)),
      })),
    ];
    datasets.push(
      ds('finance.cost', financeRows, `保理/逾期费用 ${financeRows.length} 行`),
    );
    datasets.push(
      ds(
        'asset.flow',
        orderedProjects.map((p) => {
          const summary = summarizeAssetFlow(assets.filter((a) => a.projectId === p.id));
          return {
            项目: `${p.code} ${p.name}`,
            进场数量: summary.inQty,
            进场金额: summary.inAmount,
            出场数量: summary.outQty,
            出场金额: summary.outAmount,
            费用金额: summary.feeAmount,
            未知来源: summary.unknownQty,
          };
        }),
        `资产进出场 ${assets.length} 行（费用行只计金额、不混入数量）`),
    );

    const supplierMap = new Map<string | null, { name: string; amount: number; chains: number }>();
    for (const c of contracts) {
      if (c.parentContractId) continue;
      // 供应商集中度按「签约额」：未签合同不计入（否则草稿会把集中度算偏）
      if (!isSigned(c)) continue;
      const v = rootAmount.get(c.id);
      if (v === null || v === undefined) continue;
      const hit = supplierMap.get(c.supplierId ?? null) ?? {
        name: c.supplier?.name ?? '（未填供应商）',
        amount: 0,
        chains: 0,
      };
      hit.amount = round2(hit.amount + v);
      hit.chains += 1;
      supplierMap.set(c.supplierId ?? null, hit);
    }
    const supplierTotal = [...supplierMap.values()].reduce((s, x) => s + x.amount, 0);
    const supplierRows = [...supplierMap.values()]
      .sort((a, b) => b.amount - a.amount)
      .map((s) => ({
        供应商: s.name,
        合同链数: s.chains,
        签约额: s.amount,
        占比: supplierTotal > 0 ? round2((s.amount / supplierTotal) * 100) : null,
      }));
    datasets.push(
      ds('supplier.concentration', supplierRows, `签约额前 ${supplierRows.length} 家供应商（累计口径）`),
    );

    // ---- Phase 5：补充业务单据域 ----
    datasets.push(
      ds(
        'repayment.agreement',
        repayments.map((r) => ({
          项目: projectLabel.get(r.projectId) ?? '',
          协议编号: r.code,
          供应单位: r.supplier?.name ?? '',
          供应材料: r.material ?? '',
          签订日期: r.signDate ? localDayKey(r.signDate) : null,
          结算金额: r.settleAmount === null ? null : round2(Number(r.settleAmount)),
          约定欠款: r.agreedDebtAmount === null ? null : round2(Number(r.agreedDebtAmount)),
          签约前已付: r.paidBeforeSign === null ? null : round2(Number(r.paidBeforeSign)),
          签约后已付: r.paidAfterSign === null ? null : round2(Number(r.paidAfterSign)),
          逾期未付: r.overdueUnpaid === null ? null : round2(Number(r.overdueUnpaid)),
        })),
        `还款协议 ${repayments.length} 份`),
    );
    datasets.push(
      ds(
        'final_settlement.summary',
        finalSettlements.map((f) => ({
          项目: projectLabel.get(f.projectId) ?? '',
          合同编号: f.contract?.code ?? '',
          单据编号: f.code ?? '',
          状态: f.statusCode,
          结算金额: f.totalAmount === null ? null : round2(Number(f.totalAmount)),
          结算时间: f.settledAt ? localDayKey(f.settledAt) : null,
        })),
        `工作总结算 ${finalSettlements.length} 份（累计口径）`),
    );
    datasets.push(
      ds(
        'payment_procedure.records',
        paymentProcedures.map((p) => ({
          项目: projectLabel.get(p.projectId) ?? '',
          单据编号: p.code ?? '',
          合同编号: p.contract?.code ?? '',
          开累结算: p.settleCumAmount === null ? null : round2(Number(p.settleCumAmount)),
          开累付款: p.paidCumAmount === null ? null : round2(Number(p.paidCumAmount)),
          未付款: p.unpaidAmount === null ? null : round2(Number(p.unpaidAmount)),
          付款时间: p.payDate ? localDayKey(p.payDate) : null,
          状态: p.statusCode ?? '',
        })),
        `付款手续 ${paymentProcedures.length} 张`),
    );
    datasets.push(
      ds(
        'contract.change_log',
        changeLogs.map((c) => ({
          项目: projectLabel.get(c.contract.projectId) ?? '',
          合同编号: c.contract.code,
          变更字段: c.fieldLabel || c.field,
          变更前: c.beforeValue ?? '',
          变更后: c.afterValue ?? '',
          操作人: c.operator ?? '',
          时间: localDayKey(c.createdAt),
        })),
        `合同变更 ${changeLogs.length} 条`),
    );
    datasets.push(
      ds(
        'material.base',
        materialBases.map((m) => ({
          物资名称: m.name,
          规格型号: m.spec,
          一级分类: m.categoryLevel1 ?? '',
          二级分类: m.categoryLevel2 ?? '',
          单位: m.unit ?? '',
          是否资产: m.isAsset ? '是' : '否',
          状态: m.status === 1 ? '启用' : '停用',
        })),
        `物资主数据 ${materialBases.length} 条（全局主数据）`),
    );
    datasets.push(
      ds(
        'material.contract',
        contractMaterials.map((m) => ({
          项目: projectLabel.get(m.contract.projectId) ?? '',
          合同编号: m.contract.code,
          物资名称: m.materialBase.name,
          规格型号: m.materialBase.spec,
          数量: m.qty === null ? null : round4(Number(m.qty)),
          税前单价: m.priceBeforeTax === null ? null : round4(Number(m.priceBeforeTax)),
          含税单价: m.priceWithTax === null ? null : round4(Number(m.priceWithTax)),
          含税合价: m.totalWithTax === null ? null : round4(Number(m.totalWithTax)),
          收入单价: m.incomePrice === null ? null : round4(Number(m.incomePrice)),
          标准成本价: m.stdPrice === null ? null : round4(Number(m.stdPrice)),
        })),
        `合同物资清单 ${contractMaterials.length} 行`),
    );
    datasets.push(
      ds(
        'labor.auth',
        laborAuths.map((l) => ({
          项目: projectLabel.get(l.projectId) ?? '',
          分包商: l.subcontractorName,
          法人代表: l.legalPerson ?? '',
          授权材料员: l.authorizedPerson ?? '',
          授权起: l.authStartDate ? localDayKey(l.authStartDate) : null,
          授权止: l.authEndDate ? localDayKey(l.authEndDate) : null,
          状态: l.status,
        })),
        `分包授权台账 ${laborAuths.length} 条（累计口径）`),
    );
    datasets.push(
      ds(
        'labor.receiving_doc',
        laborDocs.map((d) => ({
          项目: projectLabel.get(d.projectId) ?? '',
          单据编号: d.docNo,
          分包商: d.subcontractorName,
          结算期: d.period,
          状态: d.status,
          明细数: d._count.details,
        })),
        `分包领用单据 ${laborDocs.length} 张`),
    );

    const procurementRows: Array<Record<string, string | number | null>> = [];
    for (const t of procurementDocs) {
      const 项目 = projectLabel.get(t.projectId) ?? '';
      const add = (类型: string, date: Date | null | undefined, note: string): void => {
        if (!inRange(date, range)) return;
        procurementRows.push({
          项目,
          采购编号: t.taskNo,
          文件类型: 类型,
          日期: date ? localDayKey(date) : null,
          说明: note,
        });
      };
      if (t.procurementNotice) {
        const n = t.procurementNotice;
        add('采购公告', n.procurementTime ?? n.publishedAt ?? n.createdAt, '');
      }
      if (t.procurementDocument) {
        const d = t.procurementDocument;
        add('采购文件', d.procurementTime ?? d.publishedAt ?? d.createdAt, '');
      }
      if (t.procurementPriceCompare) {
        const p = t.procurementPriceCompare;
        add('价格对比', p.publishedAt ?? p.createdAt, '');
      }
      if (t.preMeetingMinutes) {
        const m = t.preMeetingMinutes;
        add('采前会纪要', m.meetingTime ?? m.createdAt, '');
      }
      if (t.frameworkExplanation) {
        const f = t.frameworkExplanation;
        add('框架协议事前说明', f.publishedAt ?? f.createdAt, '');
      }
      if (t.procurementResultReport) {
        const r = t.procurementResultReport;
        add('成交报告', r.openTime ?? r.publishedAt ?? r.createdAt, '');
      }
      for (const e of t.evaluations) {
        add('评标记录', e.evaluatedAt ?? t.createdAt, `${e.evaluator ?? ''} ${e.conclusion ?? ''}`.trim());
      }
    }
    for (const ins of inspections) {
      const date = ins.inspectionTime ?? ins.publishedAt ?? ins.createdAt;
      if (!inRange(date, range)) continue;
      procurementRows.push({
        项目: projectLabel.get(ins.projectId) ?? '',
        采购编号: '',
        文件类型: '考察报告',
        日期: date ? localDayKey(date) : null,
        说明: ins.unitName,
      });
    }
    datasets.push(
      ds('procurement.documents', procurementRows, `采购过程文件 ${procurementRows.length} 条`),
    );

    if (contracts.length >= 20000) warnings.push('合同行数达到 20000 上限，合同链汇总可能不完整');
    if (materials.length >= 20000) warnings.push('合同清单行数达到 20000 上限，履约清单量可能不完整');

    return {
      datasets,
      totals,
      compareTotals,
      byProject,
      warnings,
      asOf: localDayKey(new Date()),
    };
  }
}

const fmtYuan = (n: number): string =>
  Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
