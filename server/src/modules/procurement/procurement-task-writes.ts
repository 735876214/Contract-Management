import type { Prisma } from '@prisma/client';

/**
 * 采购任务（`ProcurementTask`）的**写入原语**——表归 procurement 模块所有。
 *
 * 合同签章/状态互转要把「主合同」的状态回写到任务上（DRAFT→合同编制中、SIGNED→已完成），
 * 但合同模块不能直接写采购任务表。这里只提供「改状态」这一个动作；
 * 「什么时候该改」的判断（阶段链是否走完、是否主合同）留在合同侧。
 */
type Db = Prisma.TransactionClient;

/** 更新采购任务状态（带乐观锁 version 自增，与任务自身写口径一致） */
export async function setProcurementTaskStatus(db: Db, taskId: string, status: string): Promise<void> {
  await db.procurementTask.update({
    where: { id: taskId },
    data: { status, version: { increment: 1 } } as any,
  });
}
