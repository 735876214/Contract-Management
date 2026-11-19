import type { Prisma } from '@prisma/client';

/**
 * 合同主表的**写入原语**——`Contract` 行归 contract 模块所有。
 *
 * 别的模块确实需要改合同行（总结算单结清→执行情况、资金参数、采购成交报告退回→清理草稿合同），
 * 但按 `.claude/rules/module-boundaries.md` 不能直接写表：把这些动作收敛成
 * **语义明确、无状态、可参与调用方事务**的入口。字段口径（哪些列可改、version 自增）留在本模块，
 * 调用方只表达业务意图。
 */
type Db = Prisma.TransactionClient;

/** 同步合同执行情况（已完已结 / 已完未结）——总结算单结清与撤销时用 */
export async function setContractExecStatus(db: Db, contractId: string, execStatus: string): Promise<void> {
  await db.contract.update({
    where: { id: contractId },
    data: { execStatus, version: { increment: 1 } } as any,
  });
}

/** 资金参数（付款安排/月利率/宽限期/利息上限比例）——财务模块录入用；只写传入的字段 */
export async function updateContractFundingParams(
  db: Db,
  contractId: string,
  data: {
    paymentMode?: string | null;
    monthlyRate?: number | null;
    graceDays?: number | null;
    interestCapRatio?: number | null;
  },
): Promise<void> {
  if (!Object.keys(data).length) return;
  await db.contract.update({ where: { id: contractId }, data: data as any });
}

/**
 * 删除某采购任务下**自动生成**的合同（采购成交报告退回时清孤儿）。
 * 只按 `taskId` 匹配——调用方已在状态机守卫里确认这些合同仍是草稿态。
 */
export async function deleteContractsOfTask(db: Db, taskId: string): Promise<number> {
  const r = await db.contract.deleteMany({ where: { taskId } });
  return r.count;
}
