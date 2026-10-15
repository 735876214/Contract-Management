/**
 * **合同链金额口径的单一事实源**（纯函数、零依赖）。
 *
 * 业务口径（2026-10-15 澄清）：
 * > **合同当前金额 = 主合同金额 + 补充协议金额**
 *
 * ⚠️ 为什么不能直接把 `Contract.amount` 相加：补充协议的 `amount` 是**手填自由值**，
 * 涨价/降价场景下它往往被填成"剩余数量的全值"，直接相加会把那部分**重复计入**。
 * 故补充协议参与求和的是 `changeAmount`（**带符号增量**，由 `supplement-delta.ts` 服务端重算）。
 *
 * 链的定义与 `amount-guard` 保持一致：沿 `parentContractId` 上溯到链根（防环，最多 8 层），
 * 链成员 = 链根 + 链根的**直接**补充协议。
 *
 * ⚠️ **主合同金额未填时 `currentAmount` 返回 `null`**（而不是把补充协议增量当成金额）：
 * 与 `amount-guard` 的既有口径一致——"未填"是"不可校验/未知"，不是 0。
 * 这条口径的由来（同类缺陷修过一次）见 .claude/rules/backend-conventions.md 的「金额上限」与「台账」两节。
 *
 * ⚠️ 必须保持零依赖（不得有任何 `import`）：由 `.mts` spec 直接引用。
 */

/** 链计算所需的合同行（`db.contract.findMany` 的 select 结果形状） */
export interface ContractChainRow {
  id: string;
  /** 补充协议指向的主合同；主合同为 `null` */
  parentContractId?: string | null;
  /** 主合同金额（原始值，可能为 null/''/0） */
  amount?: unknown;
  /** 补充协议的**带符号**增量（原始值） */
  changeAmount?: unknown;
}

export interface ChainAmounts {
  /** 链根（主合同）ID；合同不存在时为 `null` */
  rootId: string | null;
  /** 链成员 ID（链根在前，其后为直接补充协议） */
  chainIds: string[];
  /** 主合同金额；未填 → `null` */
  mainAmount: number | null;
  /** 补充协议累计金额（**带符号**求和，降价为负） */
  supplementTotal: number;
  /** 补充协议份数 */
  supplementCount: number;
  /**
   * **合同当前金额** = 主合同金额 + 补充协议累计。
   * 主合同金额未填 → `null`（未知，不可参与比例/上限判定）。
   */
  currentAmount: number | null;
}

/** 与 amount-guard 同款的"未填"判定（`0` 算已填） */
const isFilled = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return Number.isFinite(Number(v));
};

const round2 = (n: number) => Number((Number(n) || 0).toFixed(2));

const CHAIN_MAX_DEPTH = 8;

/**
 * 由**已取出的合同行集合**算链金额。调用方一次查全（项目内全部合同）后在内存算，
 * 不要按合同逐个查库（那会退化成 N+1）。
 *
 * @param rows 项目内（或至少覆盖整条链）的合同行
 * @param contractId 参与计算的合同（主合同或任一补充协议）
 */
export function resolveChainAmounts(rows: ContractChainRow[], contractId: string): ChainAmounts {
  const empty: ChainAmounts = {
    rootId: null,
    chainIds: [],
    mainAmount: null,
    supplementTotal: 0,
    supplementCount: 0,
    currentAmount: null,
  };
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  let id = String(contractId ?? '');
  if (!id || !byId.has(id)) return empty;

  // 上溯到链根（防环）
  let root = byId.get(id)!;
  for (let depth = 0; depth < CHAIN_MAX_DEPTH; depth++) {
    const parentId = root.parentContractId ? String(root.parentContractId) : '';
    if (!parentId || !byId.has(parentId)) break;
    root = byId.get(parentId)!;
  }
  const rootId = String(root.id);

  const supplements = rows.filter((r) => String(r.parentContractId ?? '') === rootId);
  const supplementTotal = round2(
    supplements.reduce((s, r) => s + (isFilled(r.changeAmount) ? Number(r.changeAmount) : 0), 0),
  );
  const mainAmount = isFilled(root.amount) ? round2(Number(root.amount)) : null;

  return {
    rootId,
    chainIds: [rootId, ...supplements.map((r) => String(r.id))],
    mainAmount,
    supplementTotal,
    supplementCount: supplements.length,
    currentAmount: mainAmount === null ? null : round2(mainAmount + supplementTotal),
  };
}

/* ==================================================================== *
 * 以下为**需要 db** 的链 IO：沿用「传 db 进来」的做法，本文件依旧零 import，
 * 因此可以被 `.mts` spec 直接加载（见 .claude/rules/testing.md 的第一条硬约束）。
 *
 * ⚠️ 2026-10-15 起，这些函数**只在本文件实现**（原在 amount-guard.ts）。
 * 原因：`contractChainAmount()` 必须复用上面的纯函数才能保证"上限"与"合同当前金额"
 * 是同一个口径；而 amount-guard 被 spec 加载、不能新增相对 import（.mts 硬约束），
 * 于是把链 IO 整体搬到这里，amount-guard 只保留不碰 db 的策略与比较。
 * ==================================================================== */

/** 排除草稿的 where 片段：`statusCode != 'DRAFT'` 在 SQL 里会连带排除 NULL（三值逻辑） */
const notDraft = { OR: [{ statusCode: null }, { statusCode: { not: 'DRAFT' } }] };

/** 沿 `parentContractId` 上溯取链根（主合同）ID；防环（最多 8 层） */
export async function contractChainRootId(db: any, contractId: string): Promise<string | null> {
  let id = String(contractId ?? '');
  if (!id) return null;
  for (let depth = 0; depth < CHAIN_MAX_DEPTH; depth++) {
    const c = await db.contract.findUnique({ where: { id }, select: { id: true, parentContractId: true } });
    if (!c) return depth === 0 ? null : id;
    if (!c.parentContractId) return c.id;
    id = c.parentContractId;
  }
  return id;
}

/** 取出整条链的合同行（链根 + 直接补充协议）；调用方一次拿全，避免 N+1 */
export async function contractChainRows(db: any, contractId: string): Promise<ContractChainRow[]> {
  const rootId = await contractChainRootId(db, contractId);
  if (!rootId) return [];
  const select = { id: true, parentContractId: true, amount: true, changeAmount: true };
  const root = await db.contract.findUnique({ where: { id: rootId }, select });
  const children = await db.contract.findMany({ where: { parentContractId: rootId }, select });
  return [root, ...(children ?? [])].filter(Boolean) as ContractChainRow[];
}

/** 链上全部合同 ID = 链根 + 其直接补充协议 */
export async function contractChainIds(db: any, contractId: string): Promise<string[]> {
  return resolveChainAmounts(await contractChainRows(db, contractId), contractId).chainIds;
}

/**
 * **合同当前金额**（= 防超结 / 防超付的上限）。
 *
 * 口径见文件头：主合同金额 + Σ 补充协议 `changeAmount`（带符号）。
 * **主合同未填金额 → 返回 `null`（= 无上限，不可校验）**，而不是 0 或"只算补充协议"——
 * 否则「合同没填金额」会被当成上限 0，任何一笔结算/付款都会被误判超限
 * （BLOCK 策略下会直接拦住合法单据）。
 */
export async function contractChainAmount(db: any, contractId: string): Promise<number | null> {
  const rows = await contractChainRows(db, contractId);
  if (!rows.length) return null;
  return resolveChainAmounts(rows, contractId).currentAmount;
}

/** 链上累计结算额（`actualAmount` 回退 `amount`，排除草稿与 excludeId 自身） */
export async function chainSettledTotal(db: any, contractId: string, excludeId?: string): Promise<number> {
  const ids = await contractChainIds(db, contractId);
  if (!ids.length) return 0;
  const rows = await db.settlement.findMany({
    where: { contractId: { in: ids }, ...notDraft, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { actualAmount: true, amount: true },
  });
  return round2(rows.reduce((s: number, r: any) => s + (Number(r.actualAmount ?? r.amount) || 0), 0));
}

/**
 * 链上累计付款额。
 * - `excludeId`：排除自身（编辑场景）
 * - `excludeStatuses`：排除**不构成实际出资**的状态（如 `FAILED 付款失败` / `REFUNDED 已退款`），
 *   否则一笔失败记录会虚增"累计付款"，在 BLOCK 策略下误挡后续正常付款
 */
export async function chainPaidTotal(
  db: any,
  contractId: string,
  excludeId?: string,
  excludeStatuses: string[] = [],
): Promise<number> {
  const ids = await contractChainIds(db, contractId);
  if (!ids.length) return 0;
  const rows = await db.paymentRecord.findMany({
    where: { contractId: { in: ids }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { amount: true, statusCode: true },
  });
  return round2(
    rows
      .filter((r: any) => !excludeStatuses.includes(String(r.statusCode ?? '')))
      .reduce((s: number, r: any) => s + (Number(r.amount) || 0), 0),
  );
}
