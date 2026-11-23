/**
 * **AI 数据集 / 经营分析的跨域只读取数层**（对齐 `archive-queries.ts`，见
 * `.claude/rules/module-boundaries.md` §3.1）。
 *
 * 2026-11-24（解耦路线图 P1 收尾）：这些查询原来直接写在
 * `ai-insight/analytics/dataset-collector.service.ts` 里（33 处 `prisma.<模型>`，横跨 8 张业务表），
 * 而 AI 只读子域**不得**直接读业务表——否则改一张表的列/口径就要去 AI 里改一遍，且检查器锁不住。
 * 现在口径与取数都在本层，`ai-insight/{analytics,anomaly,analysis}` 由检查器强制「不得出现 `prisma.<模型>`」。
 *
 * 约定（与其它查询层函数一致）：只读、**不带事务**、显式按 `projectId`/项目 id 集合过滤、
 * 只返回行/分组，业务整形留在 service。
 * - `q()`（按所选数据集裁剪）不搬走：那是「这次要哪几个数据集」的策略判断，由调用方以 `need` 传入。
 */
import type { PrismaClient } from '@prisma/client';
import { countedInvoiceWhere, notDraft, paidPaymentWhere } from '../constants/statuses';
import { sumSettlementAmount } from '../common/utils/group-sum';
import { ASSET_IN_SOURCES } from '../domain/asset-flow';
import { SITE_CONFIRM_STATUS } from '../constants/statuses';
import type { PayMonthRange } from './ai-fact-queries';

/** 数据集取数的日期区间（**两端都必填**：数据集按区间铺行，缺一端就没法切期） */
export interface AiDatasetRange {
  from: Date | null;
  to: Date;
}

type Db = PrismaClient;

/** 数据集的取数范围：项目 id 集合 + 日期区间 + 月份区间 + 是否只认「现场已确认」+ 单表单次上限 */
export interface AiDatasetScope {
  ids: string[];
  range: AiDatasetRange;
  monthRange: PayMonthRange | null;
  gated: boolean;
  maxRows: number;
}

/**
 * 用户有权限的项目下拉（数据集「范围」选择用；含简称，单次上限 500）。
 *
 * `memberWhere` 由 `ai-core/common/project-scope.ts` 的 `projectScopeWhere(user)` 产出——
 * 成员收口规则留在调用方，本层只执行。
 */
export function loadAiScopedProjects(db: Db, memberWhere: Record<string, unknown>) {
  return db.project.findMany({
    where: memberWhere,
    select: { id: true, code: true, name: true, nameAbbr: true },
    orderBy: { code: 'asc' },
    take: 500,
  });
}

/**
 * **当前期间的核心分组求和**（4 张表的 `groupBy + _sum`）。
 *
 * 从 `projectCore()` 提出（原先是内联在它的 `Promise.all` 里）：保理费用/逾期应付只有 `contractId`，
 * 按 `contractId` 求和后再用合同的 (id → projectId) 映射归并；`where` 里的 `contract.projectId`
 * 与那个映射同源，不会漏也不会串项目。
 */
export function loadAiProjectCoreGroups(db: Db, scope: Pick<AiDatasetScope, 'ids' | 'range' | 'monthRange'>) {
  const { ids, range, monthRange } = scope;
  return Promise.all([
  db.monthlyProfitLoss.groupBy({
    by: ['projectId'],
    where: { projectId: { in: ids }, ...(monthRange ? { period: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
    _sum: { sixSavingsAmount: true },
  }),
  db.factoringCost.groupBy({
    by: ['contractId'],
    where: { contract: { projectId: { in: ids } }, ...(range.from ? { financingDate: { gte: range.from, lte: range.to } } : {}) },
    _sum: { totalCost: true },
  }),
  db.overduePayable.groupBy({
    by: ['contractId'],
    where: { contract: { projectId: { in: ids } }, ...(monthRange ? { settlementMonth: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
    _sum: { overdueInterest: true },
  }),
  db.assetLedger.groupBy({
    by: ['projectId'],
    where: {
      projectId: { in: ids },
      sourceCode: { in: [...ASSET_IN_SOURCES] },
      ...(range.from ? { date: { gte: range.from, lte: range.to } } : {}),
    },
    _sum: { totalAmount: true },
  }),
  ]);
}

/**
 * **一次取全工作簿各数据集的明细行**（顺序与 `DatasetCollector.collect()` 的解构一一对应）。
 *
 * 全部是行级取数（**不是**聚合）：数据集要逐行铺进 Excel，`groupBy` 会丢明细。
 * `need(keys)` 是调用方传进来的「本次选了哪些数据集」判据——没选中的直接短路成空数组，
 * 避免白查一遍大表。
 */
export function loadAiDatasetBundle(db: Db, scope: AiDatasetScope, need: (...keys: string[]) => boolean) {
  const q = (keys: string[], fn: () => Promise<any[]>): Promise<any[]> => (need(...keys) ? fn() : Promise.resolve([]));
  const { ids, range, monthRange, gated, maxRows: MAX_ROWS } = scope;
  return Promise.all([
      db.project.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, name: true, nameAbbr: true, projectManager: true, startDate: true, endDate: true },
      }),
      db.contract.findMany({
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
      q(["settlement.summary","settlement.detail"], () => db.settlement.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { settleDate: { gte: range.from, lte: range.to } } : {}), ...notDraft },
        select: { projectId: true, contractId: true, code: true, amount: true, actualAmount: true, settleDate: true, statusCode: true, contract: { select: { code: true } } },
        take: MAX_ROWS,
      })),
      q(["payment.records"], () => db.paymentRecord.findMany({
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
      q(["invoice.records"], () => db.invoice.findMany({
        where: { projectId: { in: ids }, ...countedInvoiceWhere(), ...(range.from ? { invoiceDate: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, contractId: true, amountWithTax: true, invoiceDate: true, statusCode: true, contract: { select: { code: true } } },
        take: MAX_ROWS,
      })),
      q(["daily.report"], () => (db.dailyReport.groupBy as any)({
        by: ['projectId'],
        where: {
          projectId: { in: ids },
          ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}),
          ...(range.from ? { entryDate: { gte: range.from, lte: range.to } } : {}),
        },
        _count: { _all: true },
        _sum: { settleQty: true, amountAfterTax: true },
      })),
      q(["settlement.ledger"], () => db.settlementLedger.findMany({
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
      q(["procurement.task"], () => db.procurementTask.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { createdAt: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, taskNo: true, type: true, status: true },
        take: MAX_ROWS,
      })),
      q(["procurement.result"], () => db.procurementBidder.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { task: { createdAt: { gte: range.from, lte: range.to } } } : {}) },
        select: { projectId: true, bidderName: true, status: true, finalPreTaxTotal: true, task: { select: { taskNo: true } } },
        take: MAX_ROWS,
      })),
      q(["receipt.order"], () => db.receiptOrder.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { orderDate: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, orderNo: true, orderDate: true, supplierName: true, status: true, _count: { select: { details: true } } },
        take: MAX_ROWS,
      })),
      q(["cost.profit_loss"], () => db.monthlyProfitLoss.findMany({
        where: { projectId: { in: ids }, ...(monthRange ? { period: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
        select: { projectId: true, period: true, sixSavingsAmount: true, totalDeductAmount: true, _count: { select: { details: true } } },
        take: MAX_ROWS,
      })),
      q(["labor.receiving_doc"], () => db.laborReceivingDoc.findMany({
        where: { projectId: { in: ids }, ...(monthRange ? { period: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
        select: { projectId: true, docNo: true, subcontractorName: true, period: true, status: true, _count: { select: { details: true } } },
        take: MAX_ROWS,
      })),
      q(["cost.labor_receiving"], () => db.laborReceivingSummary.findMany({
        where: { projectId: { in: ids }, ...(monthRange ? { period: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
        select: {
          projectId: true,
          subcontractorName: true,
          period: true,
          materialName: true,
          spec: true,
          unit: true,
          unitPrice: true,
          returnQty: true,
          stockTakeQty: true,
          designQtyCum: true,
          lossRate: true,
        },
        take: MAX_ROWS,
      })),
      q(["finance.cost"], () => db.factoringCost.findMany({
        where: { contract: { projectId: { in: ids } }, ...(range.from ? { financingDate: { gte: range.from, lte: range.to } } : {}) },
        select: { financingDate: true, totalCost: true, settlementMonth: true, contract: { select: { code: true, projectId: true } } },
        take: MAX_ROWS,
      })),
      q(["finance.cost"], () => db.overduePayable.findMany({
        where: { contract: { projectId: { in: ids } }, ...(monthRange ? { settlementMonth: { gte: monthRange.gte, lte: monthRange.lte } } : {}) },
        select: { settlementMonth: true, overdueInterest: true, contract: { select: { code: true, projectId: true } } },
        take: MAX_ROWS,
      })),
      q(["asset.flow"], () => db.assetLedger.findMany({
        where: { projectId: { in: ids }, ...(range.from ? { date: { gte: range.from, lte: range.to } } : {}) },
        select: { projectId: true, sourceCode: true, qty: true, totalAmount: true },
        take: MAX_ROWS,
      })),
      q(["contract.fulfillment"], () => db.contractMaterial.findMany({
        where: { contract: { projectId: { in: ids } } },
        select: { qty: true, contract: { select: { projectId: true } } },
        take: 20000,
      })),
      q(["contract.fulfillment"], () => (db.dailyReport.groupBy as any)({
        by: ['projectId'],
        where: { projectId: { in: ids }, ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}) },
        _sum: { settleQty: true },
      })),
      // 合同履约的「累计审定结算额」是纯分组求和（P1-4）：口径 `actualAmount ?? amount`
      // 由 `sumSettlementAmount` 在 SQL 侧精确复刻（两次 groupBy），返回 项目 → 金额 的 Map
      // 结果是 Map（不是数组），故不走 `q()`，直接按需短路
      need("contract.fulfillment")
        ? sumSettlementAmount(db, 'projectId', { projectId: { in: ids }, ...notDraft })
        : Promise.resolve(new Map<string, number>()),
      q(["contract.fulfillment"], () => (db.paymentRecord.groupBy as any)({
        by: ['projectId'],
        where: { projectId: { in: ids }, ...paidPaymentWhere() },
        _sum: { amount: true },
      })),
      q(["contract.fulfillment"], () => (db.invoice.groupBy as any)({
        by: ['projectId'],
        where: { projectId: { in: ids }, ...countedInvoiceWhere() },
        _sum: { amountWithTax: true },
      })),
      q(["repayment.agreement"], () => db.repaymentAgreement.findMany({
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
      q(["final_settlement.summary"], () => db.finalSettlement.findMany({
        where: { projectId: { in: ids } },
        select: { projectId: true, code: true, statusCode: true, totalAmount: true, settledAt: true, createdAt: true, contract: { select: { code: true } } },
        take: MAX_ROWS,
      })),
      q(["payment_procedure.records"], () => db.paymentProcedure.findMany({
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
      q(["contract.change_log"], () => db.contractChangeLog.findMany({
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
      q(["material.base"], () => db.materialBase.findMany({
        select: { name: true, spec: true, categoryLevel1: true, categoryLevel2: true, unit: true, isAsset: true, status: true },
        take: MAX_ROWS,
      })),
      q(["material.contract"], () => db.contractMaterial.findMany({
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
      q(["labor.auth"], () => db.laborAuthLedger.findMany({
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
      q(["procurement.documents"], () => db.procurementTask.findMany({
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
      q(["procurement.documents"], () => db.inspectionReport.findMany({
        where: { projectId: { in: ids } },
        select: { projectId: true, unitName: true, inspectionTime: true, publishedAt: true, createdAt: true },
        take: MAX_ROWS,
      })),
  ]);
}
