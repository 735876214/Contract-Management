import type { Prisma } from '@prisma/client';

/**
 * 总日报（`DailyReport`）的**推送写入原语**——表归 daily-report 模块所有。
 *
 * 收领单「推送总日报」需要先清掉本单历史推送行、再批量写入新行（幂等），但它不该直接写日报表
 * （`.claude/rules/module-boundaries.md`）。行内容（字段映射、现场确认口径）仍由收领单侧组装，
 * 这里只负责落库；无状态函数 + 调用方事务句柄，可参与外层 `$transaction`。
 */
type Db = Prisma.TransactionClient;

/** 删除某张收领单**推送生成**的日报行（按显式外键 `receiptOrderId`，不碰手工导入行） */
export async function clearPushedDailyRowsOfReceiptOrder(db: Db, receiptOrderId: string): Promise<number> {
  const r = await db.dailyReport.deleteMany({ where: { receiptOrderId } });
  return r.count;
}

/** 批量写入推送生成的日报行（调用方保证行结构与日报列定义一致） */
export async function pushDailyRows(db: Db, rows: Record<string, unknown>[]): Promise<number> {
  if (!rows.length) return 0;
  const r = await db.dailyReport.createMany({ data: rows as any });
  return r.count;
}
