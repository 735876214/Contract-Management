import type { MaterialQtyRow, PaymentAnomalyInput } from './anomaly-types.ts';

/**
 * **取数形状的唯一事实源**：Prisma `select` / `where` / 行 → 规则入参的映射。
 *
 * 为什么单独一个文件：同一套取数被两处使用——
 * 1. 线上接口 `anomaly.service.ts`（`Collect` → 规则 → 措辞）；
 * 2. 离线评测脚本 `server/scripts/export-anomaly-dataset.ts`（导出 JSON → 人工标注 → 评分）。
 *
 * 如果两处各写一份 `select`，评测结论就**不再代表线上跑的东西**——那是最危险的一类漂移
 * （评测漂亮、线上报错或漏报）。所以形状只写一次，两边都从这里取。
 */

// ---------------------------------------------------------------------------
// select：只取判定需要的窄列
// ---------------------------------------------------------------------------

export const ANOMALY_SELECT = {
  contract: {
    id: true,
    parentContractId: true,
    code: true,
    name: true,
    amount: true,
    status: true,
    execStatus: true,
    ext: { select: { currentPayRatio: true } },
  },
  settlement: {
    id: true,
    contractId: true,
    code: true,
    amount: true,
    actualAmount: true,
    settleDate: true,
    statusCode: true,
    items: { select: { materialBaseId: true, qty: true, totalWithTax: true } },
  },
  payment: {
    id: true,
    contractId: true,
    amount: true,
    payDate: true,
    payMonth: true,
    statusCode: true,
  },
  invoice: {
    id: true,
    settlementId: true,
    amountWithTax: true,
    statusCode: true,
    invoiceNo: true,
  },
  procedure: {
    id: true,
    code: true,
    contractId: true,
    settleCumAmount: true,
    paidCumAmount: true,
    payDate: true,
  },
  receipt: {
    id: true,
    settlementId: true,
    orderDate: true,
  },
  finalSettlementItem: {
    id: true,
    finalSettlementId: true,
    settlementId: true,
    settleMonth: true,
    amount: true,
  },
  contractMaterial: {
    contractId: true,
    materialBaseId: true,
    qty: true,
    materialBase: { select: { name: true } },
  },
} as const;

/** 排序口径：结算/付款/手续都按日期升序（规则里"报后一张"等语义依赖稳定顺序） */
export const ANOMALY_ORDER = {
  settlement: [{ settleDate: 'asc' }, { createdAt: 'asc' }],
  payment: [{ payDate: 'asc' }, { createdAt: 'asc' }],
  procedure: [{ payDate: 'asc' }, { createdAt: 'asc' }],
} as const;

// ---------------------------------------------------------------------------
// where：**每个都显式带 projectId**（铁律 3）
// ---------------------------------------------------------------------------

export interface AnomalyDateRange {
  /** 已解析的日期（解析与报错留在调用方：接口要 400，脚本要退非 0） */
  from: Date | null;
  to: Date | null;
  contractId?: string | null;
}

export interface AnomalyWhereSet {
  contractWhere: any;
  settlementWhere: any;
  paymentWhere: any;
  procedureWhere: any;
  invoiceWhere: any;
  receiptWhere: any;
  finalSettlementItemWhere: any;
  contractMaterialWhere: any;
}

export function buildAnomalyWhere(range: AnomalyDateRange, projectId: string): AnomalyWhereSet {
  const contractId = range.contractId || undefined;
  const scoped: any = { projectId, ...(contractId ? { contractId } : {}) };
  const dateWhere: any =
    range.from || range.to
      ? { settleDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {};
  return {
    contractWhere: { projectId, ...(contractId ? { id: contractId } : {}) },
    settlementWhere: { ...scoped, ...dateWhere },
    paymentWhere: scoped,
    procedureWhere: scoped,
    // 发票/收领单按结算单间接挂项目；指定合同时再收窄一层
    invoiceWhere: {
      projectId,
      settlementId: { not: null },
      ...(contractId ? { settlement: { contractId } } : {}),
    },
    receiptWhere: { projectId, settlementId: { not: null } },
    finalSettlementItemWhere: { finalSettlement: { projectId } },
    contractMaterialWhere: { contract: { projectId } },
  };
}

// ---------------------------------------------------------------------------
// 行 → 规则入参
// ---------------------------------------------------------------------------

/** 一个项目（或一个合同）的原始取数结果，形状由上面 `ANOMALY_SELECT` 决定 */
export interface AnomalyRows {
  contracts: any[];
  settlements: any[];
  payments: any[];
  invoices: any[];
  procedures: any[];
  receipts: any[];
  finalSettlementItems: any[];
  materialRows: any[];
}

export interface AnomalyDataset {
  input: PaymentAnomalyInput;
  sample: Record<string, number>;
}

/** 合同链上溯上限（与 `contract-chain.ts` 的 CHAIN_MAX_DEPTH 同口径，防环） */
export const CHAIN_MAX_DEPTH = 8;

/**
 * 合同 id → 链根 id（父链上溯；不在集合里的返回 null）。
 *
 * 清单量必须按**链根**聚合：补充协议自己不带 `ContractMaterial`，它是共享母合同的清单量；
 * 若按签约主体各自算，补充协议永远"超额结算"，会把正常业务报成异常。
 */
export function makeChainRootResolver(contracts: ReadonlyArray<{ id: string; parentContractId?: string | null }>) {
  const byId = new Map<string, { id: string; parentContractId?: string | null }>(
    contracts.map((c) => [String(c.id), c]),
  );
  const memo = new Map<string, string | null>();
  return (id: string): string | null => {
    const key = String(id);
    if (memo.has(key)) return memo.get(key)!;
    let cur = byId.get(key);
    if (!cur) {
      memo.set(key, null);
      return null;
    }
    for (let depth = 0; depth < CHAIN_MAX_DEPTH; depth++) {
      const parentId = cur.parentContractId ? String(cur.parentContractId) : '';
      if (!parentId || !byId.has(parentId)) break;
      cur = byId.get(parentId)!;
    }
    const rootId = String(cur.id);
    memo.set(key, rootId);
    return rootId;
  };
}

/**
 * 原始行 → `PaymentAnomalyInput`（纯函数，无 IO，可单测）。
 *
 * 这里只做**形状搬运 + 一处聚合**（清单量按链根求和），不做任何判定：
 * 金额一律以 Prisma 的 Decimal/字符串原样传下去，到 `rules-payment.ts` 才转 bigint 分。
 */
export function buildPaymentAnomalyInput(rows: AnomalyRows): AnomalyDataset {
  const rootOf = makeChainRootResolver(rows.contracts as any[]);
  const materialsByKey = new Map<string, MaterialQtyRow>();
  for (const row of rows.materialRows) {
    const rootId = rootOf(String(row.contractId));
    if (!rootId) continue;
    const key = `${rootId}::${row.materialBaseId}`;
    const acc = materialsByKey.get(key);
    const qty = row.qty == null ? null : Number(row.qty);
    if (!acc) {
      materialsByKey.set(key, {
        contractId: rootId,
        materialBaseId: row.materialBaseId,
        qty: qty ?? undefined,
        name: row.materialBase?.name ?? null,
      });
    } else if (qty != null) {
      // 求和用 Number 是安全的：这里是「清单暂定数量」，只用于百分比上限判定，
      // 真正需要分位精度的金额比较全部走 bigint（见 rules-payment.ts）
      acc.qty = Number(acc.qty ?? 0) + qty;
    }
  }

  return {
    input: {
      contracts: rows.contracts.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        amount: c.amount,
        status: c.status,
        execStatus: c.execStatus,
        currentPayRatio: c.ext?.currentPayRatio ?? null,
      })),
      settlements: rows.settlements,
      payments: rows.payments,
      invoices: rows.invoices,
      procedures: rows.procedures,
      receipts: rows.receipts,
      finalSettlementItems: rows.finalSettlementItems,
      contractMaterials: [...materialsByKey.values()],
    },
    sample: {
      合同: rows.contracts.length,
      结算单: rows.settlements.length,
      付款: rows.payments.length,
      发票: rows.invoices.length,
      付款手续: rows.procedures.length,
      收领单: rows.receipts.length,
      终期结算明细: rows.finalSettlementItems.length,
      清单物资行: rows.materialRows.length,
    },
  };
}
