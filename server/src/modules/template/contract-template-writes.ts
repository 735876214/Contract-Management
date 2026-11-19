import type { Prisma } from '@prisma/client';

/**
 * 合同模板（`ContractTemplate`）的**写入原语**——表归 template 模块所有
 * （完整 CRUD、版本递增、启停用、变量管理都在 template.service.ts）。
 *
 * doc-template 模块维护「文档模板」时会顺带维护合同模板记录，但按模块边界规则不能直接写表，
 * 因此收敛到本文件。版本号自增口径与 template.service 保持一致。
 */
type Db = Prisma.TransactionClient;

/** 新建合同模板（版本号由调用方给出，与 template.service.create 的入参口径相同） */
export async function createContractTemplate(db: Db, data: Record<string, any>): Promise<any> {
  return db.contractTemplate.create({ data: data as any });
}

/** 更新合同模板（version 自增，与 template.service 的「编辑即新版本语义留档」一致） */
export async function updateContractTemplate(db: Db, id: string, data: Record<string, any>): Promise<any> {
  return db.contractTemplate.update({ where: { id }, data: { ...data, version: { increment: 1 } } as any });
}

/** 删除合同模板 */
export async function deleteContractTemplate(db: Db, id: string): Promise<void> {
  await db.contractTemplate.delete({ where: { id } });
}
