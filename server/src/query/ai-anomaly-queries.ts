/**
 * **AI 预警的跨域只读取数层**（`ai-insight/anomaly` 专用）。
 *
 * 2026-11-24（解耦路线图 P1 收尾）：这些查询原来直接写在 `anomaly.service.ts` 里
 * （12 处 `prisma.<模型>`，横跨合同/结算/付款/发票/付款手续/收领单/总结算明细/合同物资 8 张表）。
 * 现在取数在本层，口径（哪些行、哪些列、什么顺序）仍由 anomaly 域的纯函数给出：
 * `buildAnomalyWhere()` 产出 where，`ANOMALY_SELECT` / `ANOMALY_ORDER` 产出投影与排序——
 * 本层只负责「照单执行」，因此检查器可以锁住「AI 只读子域不得出现 `prisma.<模型>`」。
 *
 * ⚠️ 这些 `findMany` **全部是行级取数**（不是聚合）：9 条规则要逐单比对跨期累计、
 * 明细重合度、单笔与累计的先后关系，换成 `groupBy` 会让规则静默失去判定依据。
 * 成本只跟区间内单据量走，所以杠杆在「把区间限死」（默认近 12 个月、上限 24 个月），
 * 量测见 docs/ai-anomaly-input-cost.md。
 */
import type { PrismaClient } from '@prisma/client';
import { ANOMALY_ORDER, ANOMALY_SELECT, type AnomalyWhereSet } from '../modules/ai-insight/anomaly/anomaly-dataset';

type Db = PrismaClient;

/**
 * 预警判定所需的 9 组行（一次并发取全，调用方在内存里跑规则）。
 * 返回顺序与 `AnomalyWhereSet` 的字段一一对应，调用方按位置解构。
 */
export async function loadAnomalyRows(db: Db, w: AnomalyWhereSet) {
  const [
    contracts,
    settlements,
    cumulativeSettlements,
    payments,
    invoices,
    procedures,
    receipts,
    finalSettlementItems,
    materialRows,
  ] = await Promise.all([
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量行做跨期累计比对，分页会漏判；量级=单项目业务行
        db.contract.findMany({ where: w.contractWhere, select: ANOMALY_SELECT.contract }),
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量行（同上）
        db.settlement.findMany({
          where: w.settlementWhere,
          select: ANOMALY_SELECT.settlement,
          orderBy: ANOMALY_ORDER.settlement as any,
        }),
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量行做累计比对（同上）
        db.settlement.findMany({
          where: w.settlementCumulativeWhere,
          select: ANOMALY_SELECT.settlement,
          orderBy: ANOMALY_ORDER.settlement as any,
        }),
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量付款流水（同上）
        db.paymentRecord.findMany({
          where: w.paymentWhere,
          select: ANOMALY_SELECT.payment,
          orderBy: ANOMALY_ORDER.payment as any,
        }),
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量发票（同上）
        db.invoice.findMany({ where: w.invoiceWhere, select: ANOMALY_SELECT.invoice }),
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量付款手续（同上）
        db.paymentProcedure.findMany({
          where: w.procedureWhere,
          select: ANOMALY_SELECT.procedure,
          orderBy: ANOMALY_ORDER.procedure as any,
        }),
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量收领单（同上）
        db.receiptOrder.findMany({ where: w.receiptWhere, select: ANOMALY_SELECT.receipt }),
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量总结算明细（同上）
        db.finalSettlementItem.findMany({
          where: w.finalSettlementItemWhere,
          select: ANOMALY_SELECT.finalSettlementItem,
        }),
        // @no-limit: 行级规则判定（非聚合，不能改 groupBy）：预警规则需全量合同物资行（同上）
        db.contractMaterial.findMany({
          where: w.contractMaterialWhere,
          select: ANOMALY_SELECT.contractMaterial,
        }),
  ]);
  return { contracts, settlements, cumulativeSettlements, payments, invoices, procedures, receipts, finalSettlementItems, materialRows };
}

/** 下钻链的种子合同（不存在/不属于本项目 → `null`，由 service 转 404） */
export function loadAnomalyChainSeed(db: Db, projectId: string, contractId: string) {
  return db.contract.findFirst({
    where: { id: contractId, projectId },
    select: { id: true, parentContractId: true },
  });
}

/** 下钻链：沿 `parentContractId` 向上取一层（`null` = 到头了） */
export function loadAnomalyChainParent(db: Db, projectId: string, id: string) {
  return db.contract.findFirst({
    where: { id, projectId },
    select: { id: true, parentContractId: true },
  });
}

/** 下钻链：某层的全部补充协议（向下补齐用） */
export function loadAnomalyChainChildren(db: Db, projectId: string, frontier: string[]) {
  return db.contract.findMany({
    where: { projectId, parentContractId: { in: frontier } },
    select: { id: true },
    take: 500,
  });
}
