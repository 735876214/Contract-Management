import type { Prisma } from '@prisma/client';

/**
 * 发票 → 结算单的**挂接关系**写入（`Invoice.settlementId` 归 invoice 模块所有）。
 *
 * 为什么放在这里：结算模块需要「按结算期把发票挂上/解挂」，但它不该直接写 invoice 表
 * （`.claude/rules/module-boundaries.md`：跨模块写只能走对方模块的公开入口）。
 * 这组函数是**无状态**的，接受调用方的事务句柄（`db`），因此可以参与结算模块的 `$transaction`，
 * 语义与原地的 `updateMany` 完全一致（只搬位置，不改口径）。
 */
type Db = Prisma.TransactionClient;

/** 把一批发票挂到某张结算单（`settlementId`） */
export async function attachInvoicesToSettlement(db: Db, invoiceIds: string[], settlementId: string): Promise<number> {
  if (!invoiceIds.length) return 0;
  const r = await db.invoice.updateMany({ where: { id: { in: invoiceIds } }, data: { settlementId } });
  return r.count;
}

/**
 * 解挂一批发票（`settlementId` 置空）。
 * 可带 `projectId` 作为额外安全过滤——调用方用它防「跨项目误解挂」。
 */
export async function detachInvoices(db: Db, invoiceIds: string[], projectId?: string): Promise<number> {
  if (!invoiceIds.length) return 0;
  const r = await db.invoice.updateMany({
    where: { id: { in: invoiceIds }, ...(projectId ? { projectId } : {}) },
    data: { settlementId: null },
  });
  return r.count;
}

/** 解挂挂在某张结算单上的**全部**发票（结算单换合同/换期间时用） */
export async function detachInvoicesOfSettlement(db: Db, settlementId: string): Promise<number> {
  const r = await db.invoice.updateMany({ where: { settlementId }, data: { settlementId: null } });
  return r.count;
}
