import type { Prisma } from '@prisma/client';

/**
 * 物资相关表的**写入原语**——`MaterialBase`（物资基础库）与 `ContractMaterial`（合同物资明细）
 * 归 material 模块所有。
 *
 * 需求侧确实需要写：采购总清单提交时把「计量单位」回写基础库（唯一键 name+spec 那条）、
 * 合同把草稿清单转正式清单时整表替换。按模块边界规则不由外部模块直接建删改，
 * 收敛到本文件，字段口径留在 material 侧。
 */
type Db = Prisma.TransactionClient;

/** 回写物资基础库的计量单位（同 name+spec 的唯一记录） */
export async function updateMaterialBaseUnit(db: Db, materialBaseId: string, unit: string): Promise<void> {
  await db.materialBase.update({ where: { id: materialBaseId }, data: { unit } });
}

export interface ContractMaterialRow {
  materialBaseId: string;
  unit: string;
  /** 金额/数量列在 Prisma 里是 Decimal，允许直接透传草稿行的 Decimal 值 */
  qty: number | Prisma.Decimal;
  priceBeforeTax: number | Prisma.Decimal;
  taxRatePct: number | Prisma.Decimal;
  priceWithTax: number | Prisma.Decimal;
  totalWithTax: number | Prisma.Decimal;
  remark?: string | null;
  sortOrder?: number | null;
}

/**
 * 用给定清单**整体替换**某合同的物资明细（先删后插，须在调用方事务内执行）。
 * 语义与 material.service 的清单维护一致：一个合同的正式清单要么是旧的、要么是新的，不存在中间态。
 */
export async function replaceContractMaterials(db: Db, contractId: string, rows: ContractMaterialRow[]): Promise<number> {
  await db.contractMaterial.deleteMany({ where: { contractId } });
  for (const [i, r] of rows.entries()) {
    await db.contractMaterial.create({
      data: {
        contractId,
        materialBaseId: r.materialBaseId,
        unit: r.unit,
        qty: r.qty,
        priceBeforeTax: r.priceBeforeTax,
        taxRatePct: r.taxRatePct,
        priceWithTax: r.priceWithTax,
        totalWithTax: r.totalWithTax,
        remark: r.remark ?? null,
        sortOrder: r.sortOrder || i + 1,
      },
    });
  }
  return rows.length;
}
