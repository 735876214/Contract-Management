import type { Prisma } from '@prisma/client';

/**
 * 收领单 → 结算单的**挂接关系**写入（`ReceiptOrder.settlementId` 归 receipt-order 模块所有）。
 *
 * 结算模块按结算期把收领单挂上/解挂，但它不该直接写 receipt_order 表
 * （`.claude/rules/module-boundaries.md`：跨模块写只能走对方模块的公开入口）。
 * 无状态函数 + 调用方传入事务句柄，语义与原地的 `updateMany` 一致。
 */
type Db = Prisma.TransactionClient;

/** 把一批收领单挂到某张结算单 */
export async function attachReceiptOrdersToSettlement(
  db: Db,
  receiptOrderIds: string[],
  settlementId: string,
): Promise<number> {
  if (!receiptOrderIds.length) return 0;
  const r = await db.receiptOrder.updateMany({ where: { id: { in: receiptOrderIds } }, data: { settlementId } });
  return r.count;
}

/** 解挂一批收领单（`settlementId` 置空），可带 `projectId` 作安全过滤 */
export async function detachReceiptOrders(db: Db, receiptOrderIds: string[], projectId?: string): Promise<number> {
  if (!receiptOrderIds.length) return 0;
  const r = await db.receiptOrder.updateMany({
    where: { id: { in: receiptOrderIds }, ...(projectId ? { projectId } : {}) },
    data: { settlementId: null },
  });
  return r.count;
}

/** 解挂挂在某张结算单上的**全部**收领单 */
export async function detachReceiptOrdersOfSettlement(db: Db, settlementId: string): Promise<number> {
  const r = await db.receiptOrder.updateMany({ where: { settlementId }, data: { settlementId: null } });
  return r.count;
}
