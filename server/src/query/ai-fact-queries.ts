import { PrismaClient } from '@prisma/client';
import { notDraft } from '../common/utils/contract-chain';
import { countedInvoiceWhere, paidPaymentWhere, SITE_CONFIRM_STATUS } from '../constants/statuses';

/**
 * AI 事实层的跨域只读查询（Read Model）。
 *
 * 背景：`field-resolver` / `report` / `dataset-collector` / `scm` 各自写过一遍
 * "合同链 + 结算 + 付款 + 发票"的窗口查询，且口径（排除草稿结算、排除失败/退款付款、
 * 作废/红冲发票不计入）必须完全一致。口径分散在多处 = 同一份数据在不同 AI 能力里对不上。
 *
 * 约定：
 * - 只读、不写、不开事务；
 * - `projectIds` 必传（项目隔离）；跨项目能力由调用方显式传集合；
 * - 口径常量直接复用 `constants/statuses.ts` 与 `contract-chain.ts`，**不在这里另写算式**。
 */

export interface DayRange {
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
  userId?: string;
  isSuperAdmin?: boolean;
}

/** 项目范围（scm / report / field-resolver 共用） */
export function loadProjectScope(prisma: PrismaClient, opts: ProjectScopeOptions = {}) {
  const where: any = opts.ids?.length ? { id: { in: opts.ids } } : {};
  if (opts.userId && !opts.isSuperAdmin) where.members = { some: { userId: opts.userId } };
  return prisma.project.findMany({
    where,
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
}

/** 单个项目的表头字段（汇报材料/字段取值） */
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

/** 合同链全量行（主合同 + 补充协议）；金额链口径统一走 `contract-chain.ts` */
export function loadContractChainFacts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { signDate?: DayRange } = {},
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

/** 合同的履约/执行状态（汇报材料的派生统计用） */
export function loadContractExecStatuses(prisma: PrismaClient, projectId: string) {
  return prisma.contract.findMany({ where: { projectId }, select: { execStatus: true } });
}

/** 结算事实：默认口径排除草稿（`notDraft`，与台账/超结闸门同口径） */
export function loadSettlementFacts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { range?: DayRange; excludeDraft?: boolean } = {},
) {
  const where: any = { projectId: { in: projectIds } };
  if (opts.range?.from) where.settleDate = { gte: opts.range.from, lte: opts.range.to };
  if (opts.excludeDraft) Object.assign(where, notDraft);
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

/** 付款事实：默认口径排除失败/退款（`paidPaymentWhere`） */
export function loadPaymentFacts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: {
    range?: DayRange;
    excludeFailed?: boolean;
    /** 只有账期、没有 payDate 的付款按月份纳入（报表/分析口径） */
    payMonthRange?: PayMonthRange | null;
  } = {},
) {
  const and: any[] = [];
  if (opts.excludeFailed) and.push(paidPaymentWhere());
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

/** 发票事实：默认口径排除作废/红冲（`countedInvoiceWhere`），空状态历史票仍计入 */
export function loadInvoiceFacts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { range?: DayRange; excludeTerminal?: boolean } = {},
) {
  const where: any = { projectId: { in: projectIds } };
  if (opts.range?.from) where.invoiceDate = { gte: opts.range.from, lte: opts.range.to };
  if (opts.excludeTerminal) Object.assign(where, countedInvoiceWhere());
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

/** 日报条数（单项目，汇报材料的当期指标） */
export function countDailyReports(prisma: PrismaClient, projectId: string, range: DayRange) {
  const where: any = { projectId };
  if (range.from) where.entryDate = { gte: range.from, lte: range.to };
  return prisma.dailyReport.count({ where });
}

/** 日报条数（按项目分组；`confirmedOnly` 跟随 `settlement.require_confirmed` 开关） */
export function loadDailyReportCounts(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { range?: DayRange; confirmedOnly?: boolean } = {},
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
  opts: { range?: DayRange } = {},
) {
  const where: any = { projectId: { in: projectIds } };
  if (opts.range?.from) where.createdAt = { gte: opts.range.from, lte: opts.range.to };
  return prisma.procurementTask.groupBy({ by: ['projectId'], where, _count: { _all: true } });
}
