import type { Prisma } from '@prisma/client';

/**
 * 资产台账（`AssetLedger`）的**写入原语**——表归 asset 模块所有。
 *
 * 收领单保存后要把「是资产」的明细自动入账（需求 2.2），但它不该直接写 asset 表
 * （`.claude/rules/module-boundaries.md`）。这里只提供**写**动作，业务口径（哪些明细算资产、
 * 金额怎么算）仍留在收领单侧；无状态函数 + 调用方事务句柄，可参与外层 `$transaction`。
 */
type Db = Prisma.TransactionClient;

/** 以「收领单明细 id」为唯一键 upsert 一行台账（返回 created / updated，供调用方计数） */
export async function upsertAssetLedgerByReceiptDetail(
  db: Db,
  receiptDetailId: string,
  data: Record<string, unknown>,
): Promise<'created' | 'updated'> {
  const exist = await db.assetLedger.findUnique({ where: { receiptDetailId }, select: { id: true } });
  if (exist) {
    await db.assetLedger.update({ where: { id: exist.id }, data: { ...data, version: { increment: 1 } } as any });
    return 'updated';
  }
  await db.assetLedger.create({ data: data as any });
  return 'created';
}

/** 清空某张收领单名下**全部**台账行（表头声明「非资产」或整单撤销入账时用） */
export async function clearAssetLedgerOfReceiptOrder(db: Db, receiptOrderId: string): Promise<number> {
  const r = await db.assetLedger.deleteMany({ where: { receiptOrderId } });
  return r.count;
}

/** 清理某张收领单下**不再需要入账**的台账行（保留 `keepDetailIds` 对应的行） */
export async function clearAssetLedgerExceptReceiptDetails(
  db: Db,
  receiptOrderId: string,
  keepDetailIds: string[],
): Promise<number> {
  const where: any = { receiptOrderId };
  if (keepDetailIds.length) where.receiptDetailId = { notIn: keepDetailIds };
  const r = await db.assetLedger.deleteMany({ where });
  return r.count;
}
