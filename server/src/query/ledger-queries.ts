/**
 * **合同台账的跨域只读查询层**（对齐 `archive-queries.ts` / `dashboard-queries.ts`，见
 * `.claude/rules/module-boundaries.md` §3.1）。
 *
 * 边界说明（**与 dashboard 不同**）：台账**拥有** `SettlementLedger` 表，本表自己的读写留在
 * `ledger.service.ts`；这里只放**跨域读取**（合同/合同清单/日报/结算/发票/付款/总结算/项目）。
 * 因此检查器那套「不得出现 `prisma.<模型>`」的锁在这里不适用——台账必须碰自己的表。
 *
 * 约定：只读、不带事务、每个函数显式带 `projectId` 或由调用方传入**已按项目筛过的 id 集合**。
 */
import type { PrismaClient } from '@prisma/client';
import { countedInvoiceWhere, FINAL_SETTLEMENT_STATUS, paidPaymentWhere } from '../constants/statuses';
import { notDraft } from '../constants/statuses';

type Db = PrismaClient;

/**
 * 台账列表的一页合同（含 supplier / ext）。
 *
 * 两个分支：合规性内存筛选时 `pageIds` 已算出（只回查当页命中行，`id: { in }` 不保证顺序，
 * 排序由调用方回排）；否则走常规 `skip/take` 分页。
 */
export async function loadLedgerContractPage(
  db: Db,
  opts: { where: Record<string, any>; pageIds: string[] | null; skip: number; take: number },
) {
  const [rows, total] = await Promise.all([
    // @no-limit: 分页由调用方控制——命中 id 分支按 id 集合取当页（有界）；常规分支带 skip/take｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
    db.contract.findMany({
      where: opts.pageIds ? { ...opts.where, id: { in: opts.pageIds } } : opts.where,
      ...(opts.pageIds ? {} : { skip: opts.skip, take: opts.take }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { supplier: true, ext: true },
    }),
    db.contract.count({ where: opts.where }),
  ]);
  return { rows, total };
}

/**
 * 台账一行需要的六个跨域侧表（一次批量取回，调用方在内存里按 contractId 分组，避免 N+1）。
 *
 * 口径（改动前先看 `docs/report-metrics.md`）：
 * - 审定结算额**排除草稿**（`notDraft`）；
 * - 开累发票**排除作废/红冲**（`countedInvoiceWhere()`，空状态历史票仍计入）；
 * - 开累付款**排除失败/退款**（`paidPaymentWhere()`，空状态算有效付款）；
 * - 总结算书只取**已定案（SETTLED）**：`PENDING_ATTACHMENT` 属未定案，其 `totalAmount` 只是快照，
 *   不能进欠款基数（第 23 轮审计 P2）。
 */
export async function loadLedgerContractFacts(db: Db, contractIds: string[]) {
  if (!contractIds.length) {
    return { items: [], reports: [], ledgerRows: [], settlements: [], invoices: [], payments: [], finalSettlements: [] };
  }
  const [items, reports, ledgerRows, settlements, invoices, payments, finalSettlements] = await Promise.all([
    // @no-limit: 按当页合同 id 集合取（有界）｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
    db.contractMaterial.findMany({
      where: { contractId: { in: contractIds } },
      select: { contractId: true, materialBase: { select: { name: true } } },
    }),
    // @no-limit: 按当页合同 id 集合取（有界），仅两列｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
    db.dailyReport.findMany({
      where: { contractId: { in: contractIds } },
      select: { contractId: true, entryDate: true },
    }),
    // @no-limit: 按当页合同 id 集合取（有界），仅三列｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
    db.settlementLedger.findMany({
      where: { contractId: { in: contractIds } },
      select: { contractId: true, settleMonth: true, monthSettleAmount: true },
    }),
    // @no-limit: 按当页合同 id 集合取（有界）｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
    db.settlement.findMany({
      where: { contractId: { in: contractIds }, ...notDraft },
      select: { contractId: true, actualAmount: true, amount: true },
    }),
    // @no-limit: 按当页合同 id 集合取（有界）；另取税前/税率，供「开累发票税前 / 进项税额」逐张派生｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
    db.invoice.findMany({
      where: { contractId: { in: contractIds }, ...countedInvoiceWhere() },
      select: { contractId: true, amountBeforeTax: true, amountWithTax: true, taxRatePct: true },
    }),
    // @no-limit: 按当页合同 id 集合取（有界）｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
    db.paymentRecord.findMany({
      where: { contractId: { in: contractIds }, ...paidPaymentWhere() },
      select: { contractId: true, payMonth: true, amount: true },
    }),
    // @no-limit: 按当页合同 id 集合取（有界）；一合同至多一张（@@unique(projectId, contractId)）｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
    db.finalSettlement.findMany({
      where: { contractId: { in: contractIds }, statusCode: FINAL_SETTLEMENT_STATUS.SETTLED },
      select: { contractId: true, totalAmount: true },
    }),
  ]);
  return { items, reports, ledgerRows, settlements, invoices, payments, finalSettlements };
}

/**
 * 链解析用的合同窄投影（**按项目全量**）。
 * 本页只展示 500 行，但链成员可能不在本页，故按项目取全（合同条数与台账行数同量级），
 * 避免逐行查库退化成 N+1。
 */
export async function loadLedgerChainRows(db: Db, projectId: string) {
  // @no-limit: 链结构只能内存解析（父行可能不在当页），取的是 4 个窄列｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
  return db.contract.findMany({
    where: { projectId },
    select: { id: true, parentContractId: true, amount: true, changeAmount: true },
  });
}

/**
 * 合规性筛选的扫描输入：判定必需的窄投影 + 每合同的**最早进场日期**。
 * `groupBy + _min` 与展示侧的 `Math.min(...entryDate)` 同口径。
 */
export async function loadComplianceScan(db: Db, where: Record<string, any>) {
  // @no-limit: 内存派生列筛选必须先扫全项目合同（只取 4 个窄列、不取整行），规则无法进 SQL where｜重看触发：台账行 > 5000 时把合规性筛选下推到 SQL（内存派生列要重写口径）
  const contracts = await db.contract.findMany({
    where,
    select: {
      id: true,
      typeCode: true,
      signDate: true,
      ext: { select: { bidStartDate: true, bidWinDate: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!contracts.length) return { contracts, entryByContract: new Map<string, Date | null>() };
  const grouped = await db.dailyReport.groupBy({
    by: ['contractId'],
    where: { contractId: { in: contracts.map((c) => c.id) } },
    _min: { entryDate: true },
  });
  const entryByContract = new Map<string, Date | null>();
  grouped.forEach((g: any) => entryByContract.set(g.contractId, g._min?.entryDate ?? null));
  return { contracts, entryByContract };
}

/** 导出表头用的项目名（只读） */
export async function loadProjectBrief(db: Db, projectId: string) {
  return db.project.findUnique({ where: { id: projectId }, select: { name: true } });
}
