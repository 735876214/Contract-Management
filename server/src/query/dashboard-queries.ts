/**
 * **工作台的跨域只读查询层**（对齐 `archive-queries.ts` 的做法，见
 * `.claude/rules/module-boundaries.md` §3.1）。
 *
 * 为什么要有（2026-11-23 架构评审 P1）：`dashboard` 是纯只读聚合器，但原先在 651 行的 service 里
 * 散写了 **37 处** `prisma.<任意域模型>`——它读 10 张表（合同/结算/台账/付款/发票/总结算/付款手续/
 * 逾期应付/采购任务/履约节点）。后果是：
 * 1. 谁想改某个域的口径（比如「草稿结算不算」），得在工作台里再抄一遍 where，抄漏就是第二套口径；
 * 2. 无法用检查器约束——`archive` 能锁住「不得出现 `prisma.<模型>`」，`dashboard` 锁不住。
 *
 * 约定（与既有查询层一致）：
 * - **只读**、不带事务、**每个函数显式带 `projectId`**；
 * - 只返回**行/计数/分组**等原始数据，业务整形（标题文案、排序、预警判定）留在 service；
 * - 需要全量时才用 `// @no-limit:` 写明理由（列表/待办一律带 `take`）。
 */
import type { PrismaClient } from '@prisma/client';
import {
  CONTRACT_STATUS,
  FINAL_SETTLEMENT_STATUS,
  INVOICE_STATUS,
  MILESTONE_STATUS,
  SETTLEMENT_STATUS,
  countedInvoiceWhere,
  notDraft,
  paidPaymentWhere,
} from '../constants/statuses';
import { sumSettlementAmount } from '../common/utils/group-sum';

type Db = PrismaClient;

/* ------------------------------------------------------------------ *
 * 总览 / 趋势 / 发票统计
 * ------------------------------------------------------------------ */

/**
 * 工作台总览的四个「非合同」总量。
 *
 * 口径（与台账/闸门同源，改动前请先看 `docs/report-metrics.md`）：
 * - 累计结算 = 台账 `monthSettleAmount` 之和；
 * - 累计付款**排除失败/退款**（`paidPaymentWhere()`，空状态算有效付款）；
 * - 累计开票**排除作废/红冲**（`countedInvoiceWhere()`，空状态历史票仍计入）。
 */
export async function loadOverviewTotals(db: Db, projectId: string) {
  const [ledgerSum, paymentSum, invoiceSum, settlementCount] = await Promise.all([
    db.settlementLedger.aggregate({ where: { projectId }, _sum: { monthSettleAmount: true } }),
    db.paymentRecord.aggregate({ where: { projectId, ...paidPaymentWhere() }, _sum: { amount: true } }),
    db.invoice.aggregate({ where: { projectId, ...countedInvoiceWhere() }, _sum: { amountWithTax: true } }),
    db.settlement.count({ where: { projectId } }),
  ]);
  return {
    settleAmountSum: ledgerSum._sum.monthSettleAmount,
    paidAmountSum: paymentSum._sum.amount,
    invoiceAmountSum: invoiceSum._sum.amountWithTax,
    settlementCount,
  };
}

/**
 * 合同链所需的窄投影（**聚合专用**，不要换成 `select *`）。
 * 工作台总览、类型分布、金额预警共用——链结构只能靠 `parentContractId` 在内存里解析。
 */
export async function loadContractChainRows(db: Db, projectId: string) {
  // @no-limit: 项目内全部合同（聚合输入的窄投影，每项目量级几十~几百行；分页会让合计失真）
  return db.contract.findMany({
    where: { projectId },
    select: {
      id: true,
      parentContractId: true,
      amount: true,
      changeAmount: true,
      typeCode: true,
      execStatus: true,
    },
  });
}

/** 近 N 个月趋势用的分组（结算按 `settleMonth`、付款按 `payMonth`，两者本身就是 `YYYY-MM` 字符串） */
export async function loadTrendGroups(db: Db, projectId: string) {
  const [settleGroups, payGroups] = await Promise.all([
    db.settlementLedger.groupBy({
      by: ['settleMonth'],
      where: { projectId },
      _sum: { monthSettleAmount: true },
    }),
    db.paymentRecord.groupBy({
      by: ['payMonth'],
      where: { projectId, ...paidPaymentWhere() },
      _sum: { amount: true },
    }),
  ]);
  return { settleGroups, payGroups };
}

/** 发票按类型（只算有效票）/按状态（全状态）两种分组 */
export async function loadInvoiceStatsGroups(db: Db, projectId: string) {
  const [byType, byStatus] = await Promise.all([
    db.invoice.groupBy({
      by: ['typeCode'],
      where: { projectId, ...countedInvoiceWhere() },
      _count: { _all: true },
      _sum: { amountWithTax: true },
    }),
    db.invoice.groupBy({ by: ['statusCode'], where: { projectId }, _count: { _all: true } }),
  ]);
  return { byType, byStatus };
}

/* ------------------------------------------------------------------ *
 * 待办（每类一个 loader：where/投影/上限都收在这里，service 只做整形）
 * ------------------------------------------------------------------ */

/** 待查验发票（工作台提醒 + 待办共用同一口径） */
export function loadInvoicesToVerify(db: Db, projectId: string, take?: number) {
  const where = { projectId, statusCode: INVOICE_STATUS.WAIT_VERIFY };
  return Promise.all([
    // @no-limit: take 由调用方决定（工作台传 5、待办页取全部命中），同一 where 另有一条 count 配套
    db.invoice.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      ...(take == null ? {} : { take }),
      select: { id: true, invoiceNo: true, issuer: true, amountWithTax: true },
    }),
    db.invoice.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/** 合同起草超时（草稿中且创建超过 `since`） */
export function loadOverdueDraftContracts(db: Db, projectId: string, opts: { since: Date; take: number }) {
  const where = { projectId, status: CONTRACT_STATUS.DRAFT, createdAt: { lt: opts.since } };
  return Promise.all([
    db.contract.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: opts.take,
      select: { id: true, code: true, name: true, createdAt: true },
    }),
    db.contract.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/** 合同待签章（已归档的不进待办；过滤放 where 里保证 count 与 items 同口径） */
export function loadContractsToSign(db: Db, projectId: string, take: number) {
  const where = { projectId, status: CONTRACT_STATUS.APPROVING, archivedAt: null };
  return Promise.all([
    db.contract.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true, code: true, name: true },
    }),
    db.contract.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/** 结算单草稿待提交 */
export function loadDraftSettlements(db: Db, projectId: string, take: number) {
  const where = { projectId, statusCode: SETTLEMENT_STATUS.DRAFT };
  return Promise.all([
    db.settlement.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true, code: true, amount: true, contract: { select: { name: true } } },
    }),
    db.settlement.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/** 总结算单未「已结算」（`DONE_SETTLED` 是合同执行状态的值，不能拿来判总结算单） */
export function loadUnsettledFinalSettlements(db: Db, projectId: string, take: number) {
  const where = { projectId, statusCode: { not: FINAL_SETTLEMENT_STATUS.SETTLED } };
  return Promise.all([
    db.finalSettlement.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true, code: true, statusCode: true, contract: { select: { name: true } } },
    }),
    db.finalSettlement.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/** 付款手续未付款（`payDate` 为空） */
export function loadUnpaidPaymentProcedures(db: Db, projectId: string, take: number) {
  const where = { projectId, payDate: null };
  return Promise.all([
    db.paymentProcedure.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true, code: true, contract: { select: { name: true } } },
    }),
    db.paymentProcedure.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/**
 * 履约节点逾期（未完成且计划日期已过）。
 * 归档合同不出现在待办：过滤放进 `where`，保证 `count` 与 `items` 同口径。
 */
export function loadOverdueMilestones(db: Db, projectId: string, opts: { today: Date; take: number }) {
  const where = {
    projectId,
    planDate: { lt: opts.today },
    statusCode: { notIn: [MILESTONE_STATUS.DONE, MILESTONE_STATUS.SKIPPED] },
    contract: { archivedAt: null },
  };
  return Promise.all([
    db.contractFulfillment.findMany({
      where,
      orderBy: { planDate: 'asc' },
      take: opts.take,
      select: {
        id: true,
        name: true,
        planDate: true,
        contract: { select: { id: true, code: true, name: true, archivedAt: true } },
      },
    }),
    db.contractFulfillment.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/**
 * 逾期利息待对账：`finance` 的应付款项按 `contractId` 归属（没有 `projectId`），
 * 所以先取本项目合同 id 再查其逾期行。合同 id 只作过滤条件，**不截断**（截断会让待办静默少行）。
 */
export async function loadOverdueInterestPayables(db: Db, projectId: string, take: number) {
  // @no-limit: 仅取本项目合同的 id（单列，开销很小）；截断会让超出部分的逾期行静默消失
  const contracts = await db.contract.findMany({
    where: { projectId, archivedAt: null },
    select: { id: true },
  });
  const contractIds = contracts.map((c) => c.id);
  if (!contractIds.length) return { rows: [] as Array<any>, count: 0 };
  const where = {
    contractId: { in: contractIds },
    waived: false,
    overdueInterest: { gt: 0 },
  };
  return Promise.all([
    db.overduePayable.findMany({
      where,
      orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }],
      take,
      select: {
        id: true,
        contractId: true,
        settlementMonth: true,
        periodSeq: true,
        payableAmount: true,
        overdueInterest: true,
      },
    }),
    db.overduePayable.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/** 采购待编制（各阶段未填写/编辑中） */
export function loadProcurementTodos(db: Db, projectId: string, take: number) {
  const where = { projectId, status: { in: ['NOT_STARTED', 'LIST_EDITING'] } };
  return Promise.all([
    db.procurementTask.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true, taskNo: true, content: true, status: true },
    }),
    db.procurementTask.count({ where }),
  ]).then(([rows, count]) => ({ rows, count }));
}

/* ------------------------------------------------------------------ *
 * 两个预警的数据源
 * ------------------------------------------------------------------ */

/** 合同金额预警：合同行（含链字段，排除归档）+ 按合同聚合的结算额 */
export async function loadAmountAlertSources(db: Db, projectId: string) {
  const [contracts, settledByContract] = await Promise.all([
    // @no-limit: 金额预警必须逐条链算（主合同 + Σ changeAmount），链结构只能内存解析；已是窄列
    db.contract.findMany({
      where: { projectId, archivedAt: null },
      select: { id: true, parentContractId: true, amount: true, changeAmount: true, code: true, name: true },
    }),
    // 结算额按合同聚合走 SQL：口径 = `actualAmount ?? amount`、排除草稿（`sumSettlementAmount` 与闸门同源）
    sumSettlementAmount(db, 'contractId', { projectId, ...notDraft }),
  ]);
  return { contracts, settledByContract };
}

/** 付款超比例预警：链行 + 开累结算 + 开累付款 + 生效比例（派生列） */
export async function loadPaymentRatioAlertSources(db: Db, projectId: string) {
  // @no-limit: 逐条链算预警，链结构只能内存解析；窄列（4 列）
  const contracts = await db.contract.findMany({
    where: { projectId },
    select: { id: true, parentContractId: true, code: true, name: true },
  });
  const [settledByContract, paidGroups] = await Promise.all([
    sumSettlementAmount(db, 'contractId', { projectId, ...notDraft }),
    db.paymentRecord.groupBy({
      by: ['contractId'],
      where: { projectId, ...paidPaymentWhere() },
      _sum: { amount: true },
    }),
  ]);
  // 生效比例派生列只取本项目合同（原先无 where 全表读，合同越多越慢，也违反「必须自带 projectId」）
  const exts = contracts.length
    ? await db.contractExt.findMany({
        where: { contractId: { in: contracts.map((c) => c.id) } },
        select: { contractId: true, currentPayRatio: true },
      })
    : [];
  return { contracts, settledByContract, paidGroups, exts };
}
