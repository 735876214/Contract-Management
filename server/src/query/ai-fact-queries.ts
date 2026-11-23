import { PrismaClient } from '@prisma/client';
import { notDraft } from '../constants/statuses';
import { ASSET_IN_SOURCES } from '../common/utils/asset-flow';
import { countedInvoiceWhere, paidPaymentWhere, SITE_CONFIRM_STATUS } from '../constants/statuses';

/**
 * AI 事实层的跨域只读查询（Read Model）。
 *
 * 背景：`field-resolver` / `report` / `dataset-collector` / `scm` 各自写过一遍
 * "合同链 + 结算 + 付款 + 发票 + 台账/成本/采购/资产/日报"的查询，且口径
 * （排除草稿结算、排除失败/退款付款、作废/红冲发票不计入）必须完全一致。
 * 口径分散在多处 = 同一份数据在不同 AI 能力里对不上。
 *
 * 约定：
 * - 只读、不写、不开事务；
 * - `projectIds` 必传（项目隔离）；跨项目能力由调用方显式传集合；
 * - 口径常量直接复用 `constants/statuses.ts` 与 `contract-chain.ts`，**不在这里另写算式**；
 * - **业务口径是默认值**：`load*Facts` 默认就排除草稿/失败/终态，需要原始行时显式传 `false`。
 */

/**
 * 查询层用的**部分区间**（from 可为空 = 不限起点）。
 * 与 `modules/ai/common/period.ts` 的 `DayRange` 形状兼容（那个 from 可 null、to 必有），
 * 但不 import 它——query 是基础设施层，不反向依赖业务模块。
 */
export interface FactDateRange {
  from?: Date | null;
  to?: Date | null;
}

export interface PayMonthRange {
  gte: string;
  lte: string;
}

export interface ProjectScopeOptions {
  /** 显式项目集合；不传 = 不按 id 过滤（仍受成员关系约束） */
  ids?: string[];
  /** 成员收口条件，由 `ai/common/project-scope.ts` 的 `projectScopeWhere()` 产出 */
  memberWhere?: Record<string, unknown>;
}

/** 项目范围（scm / report / field-resolver 共用） */
export function loadProjectScope(prisma: PrismaClient, opts: ProjectScopeOptions = {}) {
  const where: any = {
    ...(opts.ids?.length ? { id: { in: opts.ids } } : {}),
    ...(opts.memberWhere ?? {}),
  };
  return prisma.project.findMany({
    where,
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
}

/** 单个项目的表头字段（汇报材料） */
export function loadProjectHeader(prisma: PrismaClient, projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      code: true,
      projectManager: true,
      startDate: true,
      endDate: true,
      selfContractAmount: true,
    },
  });
}

/** 单个项目的取值字段（AI 填表用；含项目全量展示字段） */
export function loadProjectFacts(prisma: PrismaClient, projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      nameAbbr: true,
      code: true,
      codeAbbr: true,
      undertaker: true,
      packageLeader: true,
      projectManager: true,
      provinceCity: true,
      siteLocation: true,
      projectAddress: true,
      materialOrigin: true,
      industryType: true,
      selfContractAmount: true,
      startDate: true,
      endDate: true,
      settlementStartDate: true,
    },
  });
}

/** 合同链全量行（主合同 + 补充协议）；金额链口径统一走 `contract-chain.ts` */
export function loadContractChainFacts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { signDate?: FactDateRange } = {},
) {
  const where: any = { projectId: { in: projectIds } };
  if (opts.signDate?.from) where.signDate = { gte: opts.signDate.from, lte: opts.signDate.to };
  return prisma.contract.findMany({
    where,
    select: {
      id: true,
      projectId: true,
      supplierId: true,
      status: true,
      amount: true,
      changeAmount: true,
      parentContractId: true,
      signDate: true,
    },
  });
}

/** 单份合同 + 扩展字段（AI 填表用；显式限定 projectId，跨项目 id 直接当不存在） */
export function loadContractForFields(prisma: PrismaClient, contractId: string, projectId: string) {
  return prisma.contract.findFirst({
    where: { id: contractId, projectId },
    select: {
      id: true,
      supplierId: true,
      code: true,
      name: true,
      typeCode: true,
      signDate: true,
      amount: true,
      taxRatePct: true,
      execStatus: true,
      remark: true,
      ext: { select: { currentPayRatio: true } },
    },
  });
}

/** 合同的履约/执行状态（汇报材料的派生统计用） */
export function loadContractExecStatuses(prisma: PrismaClient, projectId: string) {
  // @no-limit: 派生统计需要全项目的执行状态（AI 汇报材料），分页会漏数
  return prisma.contract.findMany({ where: { projectId }, select: { execStatus: true } });
}

/** 结算事实：**默认排除草稿**（`notDraft`，与台账/超结闸门同口径） */
export function loadSettlementFacts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { range?: FactDateRange; excludeDraft?: boolean } = {},
) {
  const where: any = { projectId: { in: projectIds } };
  if (opts.range?.from) where.settleDate = { gte: opts.range.from, lte: opts.range.to };
  if (opts.excludeDraft !== false) Object.assign(where, notDraft);
  return prisma.settlement.findMany({
    where,
    select: {
      id: true,
      projectId: true,
      statusCode: true,
      amount: true,
      actualAmount: true,
      settleDate: true,
    },
  });
}

/** 付款事实：**默认排除失败/退款**（`paidPaymentWhere`） */
export function loadPaymentFacts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: {
    range?: FactDateRange;
    excludeFailed?: boolean;
    /** 只有账期、没有 payDate 的付款按月份纳入（报表/分析口径） */
    payMonthRange?: PayMonthRange | null;
  } = {},
) {
  const and: any[] = [];
  if (opts.excludeFailed !== false) and.push(paidPaymentWhere());
  if (opts.range?.from) {
    const or: any[] = [{ payDate: { gte: opts.range.from, lte: opts.range.to } }];
    if (opts.payMonthRange) {
      or.push({ payDate: null, payMonth: { gte: opts.payMonthRange.gte, lte: opts.payMonthRange.lte } });
    }
    and.push({ OR: or });
  }
  const where: any = { projectId: { in: projectIds }, ...(and.length ? { AND: and } : {}) };
  return prisma.paymentRecord.findMany({
    where,
    select: { id: true, projectId: true, statusCode: true, amount: true, payDate: true, payMonth: true },
  });
}

/** 发票事实：**默认排除作废/红冲**（`countedInvoiceWhere`），空状态历史票仍计入 */
export function loadInvoiceFacts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { range?: FactDateRange; excludeTerminal?: boolean } = {},
) {
  const where: any = { projectId: { in: projectIds } };
  if (opts.range?.from) where.invoiceDate = { gte: opts.range.from, lte: opts.range.to };
  if (opts.excludeTerminal !== false) Object.assign(where, countedInvoiceWhere());
  return prisma.invoice.findMany({
    where,
    select: { id: true, projectId: true, statusCode: true, amountWithTax: true, invoiceDate: true },
  });
}

/** 履约节点（跨项目全景） */
export function loadMilestoneFacts(prisma: PrismaClient, projectIds: string[]) {
  return prisma.contractFulfillment.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true, projectId: true, contractId: true, statusCode: true, planDate: true },
  });
}

/** 供应商名称（按 id 批量） */
export function loadSupplierNames(prisma: PrismaClient, ids: string[]) {
  if (!ids.length) return Promise.resolve([] as Array<{ id: string; name: string }>);
  return prisma.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
}

/** 单个供应商的取值字段（AI 填表用） */
export function loadSupplierById(prisma: PrismaClient, supplierId: string) {
  return prisma.supplier.findFirst({
    where: { id: supplierId },
    select: {
      id: true,
      name: true,
      legalPerson: true,
      contactName: true,
      contactPhone: true,
      contactEmail: true,
      bankName: true,
      bankAccount: true,
      address: true,
    },
  });
}

/** 日报条数（单项目，汇报材料的当期指标） */
export function countDailyReports(prisma: PrismaClient, projectId: string, range: FactDateRange) {
  const where: any = { projectId };
  if (range.from) where.entryDate = { gte: range.from, lte: range.to };
  return prisma.dailyReport.count({ where });
}

/** 日报条数（按项目分组；`confirmedOnly` 跟随 `settlement.require_confirmed` 开关） */
export function loadDailyReportCounts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { range?: FactDateRange; confirmedOnly?: boolean } = {},
) {
  const where: any = { projectId: { in: projectIds } };
  if (opts.confirmedOnly) where.confirmStatusCode = SITE_CONFIRM_STATUS.CONFIRMED;
  if (opts.range?.from) where.entryDate = { gte: opts.range.from, lte: opts.range.to };
  return prisma.dailyReport.groupBy({ by: ['projectId'], where, _count: { _all: true } });
}

/** 采购任务条数（按项目分组） */
export function loadProcurementTaskCounts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { range?: FactDateRange } = {},
) {
  const where: any = { projectId: { in: projectIds } };
  if (opts.range?.from) where.createdAt = { gte: opts.range.from, lte: opts.range.to };
  return prisma.procurementTask.groupBy({ by: ['projectId'], where, _count: { _all: true } });
}

/**
 * 业务域标量（台账 / 成本 / 采购 / 资产 / 日报）：AI 填表的一批单值指标。
 * 一次性并行取回，避免调用方再手写 9 条跨域查询。
 */
export async function loadDomainScalars(
  prisma: PrismaClient,
  opts: {
    projectIds: string[];
    /** 按业务发生日的区间（采购任务 createdAt、日报 entryDate、资产 date） */
    dateRange: { gte: Date; lte: Date };
    /** 按账期月份的区间（台账 settleMonth、盈亏 period） */
    monthRange: { gte: string; lte: string };
  },
) {
  const ids = opts.projectIds;
  const { dateRange, monthRange } = opts;
  const [ledgerCount, ledgerCum, plCount, plSavings, taskCount, assetTotal, assetIn, daily, dailyConfirmed] =
    await Promise.all([
      prisma.settlementLedger.count({ where: { projectId: { in: ids }, settleMonth: monthRange } }),
      prisma.settlementLedger.aggregate({
        _sum: { cumPurchaseAmount: true },
        where: { projectId: { in: ids }, settleMonth: monthRange },
      }),
      prisma.monthlyProfitLoss.count({ where: { projectId: { in: ids }, period: monthRange } }),
      prisma.monthlyProfitLoss.aggregate({
        _sum: { sixSavingsAmount: true },
        where: { projectId: { in: ids }, period: monthRange },
      }),
      prisma.procurementTask.count({ where: { projectId: { in: ids }, createdAt: dateRange } }),
      prisma.assetLedger.aggregate({ _sum: { originalTotal: true }, where: { projectId: { in: ids } } }),
      prisma.assetLedger.aggregate({
        _sum: { qty: true },
        where: { projectId: { in: ids }, sourceCode: { in: [...ASSET_IN_SOURCES] }, date: dateRange },
      }),
      prisma.dailyReport.count({ where: { projectId: { in: ids }, entryDate: dateRange } }),
      prisma.dailyReport.count({
        where: { projectId: { in: ids }, confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED, entryDate: dateRange },
      }),
    ]);
  return {
    ledgerMonthCount: ledgerCount,
    ledgerCumPurchaseAmount: ledgerCum._sum.cumPurchaseAmount,
    profitLossCount: plCount,
    sixSavingsAmount: plSavings._sum.sixSavingsAmount,
    procurementTaskCount: taskCount,
    assetOriginalTotal: assetTotal._sum.originalTotal,
    assetInQty: assetIn._sum.qty,
    dailyReportCount: daily,
    dailyConfirmedReportCount: dailyConfirmed,
  };
}
