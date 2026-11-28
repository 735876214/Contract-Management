/**
 * **合同链读取（跨域只读查询层）** —— 链根上溯、链行取回，以及按链归集的累计结算 /
 * 累计付款 / 清单量。对齐 `archive-queries.ts` / `dashboard-queries.ts`（见
 * `.claude/rules/module-boundaries.md` §3.1）。
 *
 * 2026-11-23 架构评审 P2 从 `domain/contract-chain.ts` 拆出：
 * - **算式只有一份**，在 `server/src/domain/contract-chain.ts`（纯函数，本文件调用它）；
 * - 本文件只负责**读表**：contract / settlement / settlementItem / paymentRecord / contractMaterial
 *   —— 这五张表分别属于 contract / settlement / payment / material，跨域读取按 §3.1 归本层。
 * - 排除草稿的谓词用 `constants/statuses.ts` 的 `notDraft`（不再内联 where）。
 *
 * 约定（与其它查询层函数同形状）：只读、**不带事务**、`db` 由调用方传入。
 * ⚠️ 调用方一律传 `this.prisma`；不要在 `$transaction` 里用 `tx` 调这些函数——
 * 那会把跨域读拉进事务（事务边界见 .claude/rules/backend-conventions.md）。
 */
import type { PrismaClient } from '@prisma/client';
import { notDraft } from '../constants/statuses.ts';
import { sumAmounts } from '@cms/calc';
import {
  CHAIN_MAX_DEPTH,
  resolveChainAmounts,
  type ContractChainRow,
} from '../domain/contract-chain.ts';

type Db = PrismaClient;

/** 沿 `parentContractId` 上溯取链根（主合同）ID；防环（最多 8 层） */
export async function contractChainRootId(db: Db, contractId: string): Promise<string | null> {
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
export async function contractChainRows(db: Db, contractId: string): Promise<ContractChainRow[]> {
  const rootId = await contractChainRootId(db, contractId);
  if (!rootId) return [];
  const select = { id: true, parentContractId: true, amount: true, changeAmount: true };
  const root = await db.contract.findUnique({ where: { id: rootId }, select });
  // @no-limit: 链成员 = 链根 + 其**直接**补充协议，天然有界（不随项目体量增长）
  const children = await db.contract.findMany({ where: { parentContractId: rootId }, select });
  return [root, ...(children ?? [])].filter(Boolean) as ContractChainRow[];
}

/** 链上全部合同 ID = 链根 + 其直接补充协议 */
export async function contractChainIds(db: Db, contractId: string): Promise<string[]> {
  return resolveChainAmounts(await contractChainRows(db, contractId), contractId).chainIds;
}

/**
 * **合同当前金额**（= 防超结 / 防超付的上限）。
 *
 * 口径见 `domain/contract-chain.ts` 文件头：主合同金额 + Σ 补充协议 `changeAmount`（带符号）。
 * **主合同未填金额 → 返回 `null`（= 无上限，不可校验）**，而不是 0 或"只算补充协议"——
 * 否则「合同没填金额」会被当成上限 0，任何一笔结算/付款都会被误判超限
 * （BLOCK 策略下会直接拦住合法单据）。
 */
export async function contractChainAmount(db: Db, contractId: string): Promise<number | null> {
  const rows = await contractChainRows(db, contractId);
  if (!rows.length) return null;
  return resolveChainAmounts(rows, contractId).currentAmount;
}

/** 链上累计结算额（`actualAmount` 回退 `amount`，排除草稿与 excludeId 自身） */
// @metric: contract-settled-total
export async function chainSettledTotal(db: Db, contractId: string, excludeId?: string): Promise<number> {
  const ids = await contractChainIds(db, contractId);
  if (!ids.length) return 0;
  // @no-limit: 链内合同 id 集合取结算（链成员 = 链根 + 直接补充协议），单据量级有界
  const rows = await db.settlement.findMany({
    where: { contractId: { in: ids }, ...notDraft, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { actualAmount: true, amount: true },
  });
  return sumAmounts(rows, (r: any) => r.actualAmount ?? r.amount);
}

/**
 * **链上清单量基线**（按 materialBaseId 求和；清单项级结算明细的"可结量"上限，业务 2026-10-17）。
 * 链成员 = 链根 + 其直接补充协议（与金额口径同一条链）——补充协议清单行自身在链上，
 * 求和即含已生效变更增量；同物资跨链成员叠加。
 * 返回 Map(materialBaseId → 合计 qty)；链上没有清单 → 空 Map。
 */
// @metric: contract-material-qty
export async function chainMaterialQty(db: Db, contractId: string): Promise<Map<string, number>> {
  const ids = await contractChainIds(db, contractId);
  const map = new Map<string, number>();
  if (!ids.length) return map;
  // @no-limit: 按链内合同 id 集合取清单行，链成员数有界（不随项目体量增长）
  const rows = await db.contractMaterial.findMany({
    where: { contractId: { in: ids } },
    select: { materialBaseId: true, qty: true },
  });
  for (const r of rows) {
    if (!r.materialBaseId) continue;
    map.set(r.materialBaseId, (map.get(r.materialBaseId) || 0) + (Number(r.qty) || 0));
  }
  return map;
}

/** 链上已结算明细量（SettlementItem 按 materialBaseId 求和；排除 excludeId 结算单自身，排除草稿单） */
export async function chainSettledItemQty(
  db: Db,
  contractId: string,
  excludeId?: string,
): Promise<Map<string, number>> {
  const ids = await contractChainIds(db, contractId);
  const map = new Map<string, number>();
  if (!ids.length) return map;
  // @no-limit: 按链内合同 id 集合取结算明细，链成员与单据量级有界
  const rows = await db.settlementItem.findMany({
    where: {
      settlement: {
        contractId: { in: ids },
        ...notDraft,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    },
    select: { materialBaseId: true, qty: true },
  });
  for (const r of rows) {
    if (!r.materialBaseId) continue;
    map.set(r.materialBaseId, (map.get(r.materialBaseId) || 0) + (Number(r.qty) || 0));
  }
  return map;
}

/**
 * 链上累计付款额。
 * - `excludeId`：排除自身（编辑场景）
 * - `excludeStatuses`：排除**不构成实际出资**的状态（如 `FAILED 付款失败` / `REFUNDED 已退款`），
 *   否则一笔失败记录会虚增"累计付款"，在 BLOCK 策略下误挡后续正常付款
 */
// @metric: contract-paid-total
export async function chainPaidTotal(
  db: Db,
  contractId: string,
  excludeId?: string,
  excludeStatuses: string[] = [],
): Promise<number> {
  const ids = await contractChainIds(db, contractId);
  if (!ids.length) return 0;
  // @no-limit: 按链内合同 id 集合取付款记录，链成员与单据量级有界
  const rows = await db.paymentRecord.findMany({
    where: { contractId: { in: ids }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { amount: true, statusCode: true },
  });
  return sumAmounts(
    rows.filter((r) => !excludeStatuses.includes(String(r.statusCode ?? ''))),
    (r: any) => r.amount,
  );
}
