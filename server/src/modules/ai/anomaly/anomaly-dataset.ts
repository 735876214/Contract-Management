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

/** 本地时区的 `YYYY-MM-DD`（规则层比日期只用字符串，避免时区漂移） */
function dayOf(d: Date | null | undefined): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface AnomalyDateRange {
  /** 已解析的日期（解析与报错留在调用方：接口要 400，脚本要退非 0） */
  from: Date | null;
  to: Date | null;
  contractId?: string | null;
  /**
   * **已展开的合同链 id 集合**（链根 + 直接补充协议）。
   *
   * 为什么要单独一个字段（2026-10-23 审计）：只看单合同会把链切断——
   * 按补充协议下钻时母合同上的清单量取不到（R1-b 直接退化成「没有清单量未判定」），
   * 母合同上的结算取不到（R2 分母变 0 → 假超 High 超付），付款记在补充协议上时
   * 母合同侧又看不到。`contractId` 保留给「只按这一个合同」的旧行为，
   * service/脚本一律传展开后的 `contractIds`。
   */
  contractIds?: string[] | null;
}

export interface AnomalyWhereSet {
  contractWhere: any;
  /** 判定对象：结算日期落在区间内 */
  settlementWhere: any;
  /** 累计口径：结算日期 ≤ 区间末端（累计类规则要用） */
  settlementCumulativeWhere: any;
  paymentWhere: any;
  procedureWhere: any;
  invoiceWhere: any;
  receiptWhere: any;
  finalSettlementItemWhere: any;
  contractMaterialWhere: any;
}

export function buildAnomalyWhere(range: AnomalyDateRange, projectId: string): AnomalyWhereSet {
  // 链范围优先用展开后的 contractIds；没展开时退回单个 contractId（老行为）
  const chainIds =
    range.contractIds && range.contractIds.length
      ? [...new Set(range.contractIds.map(String))]
      : range.contractId
        ? [String(range.contractId)]
        : null;
  // 只有一个 id 时用等值条件（与老行为一致，也更好读）；多于一个才用 in
  const singleChainId = chainIds && chainIds.length === 1 ? chainIds[0] : null;
  // 合同维度的收窄条件：**必须同一个条件用到所有明细取数上**，
  // 否则「判定集按链收窄、总结算明细按项目全取」会让 R1-c 把其它合同的结算单
  // 当成「不在本项目中」（2026-10-23 审计 P1-1）
  const byContract: any = chainIds
    ? singleChainId
      ? { contractId: singleChainId }
      : { contractId: { in: chainIds } }
    : {};
  const byContractId: any = chainIds ? (singleChainId ? { id: singleChainId } : { id: { in: chainIds } }) : {};
  const scoped: any = { projectId, ...byContract };
  const windowWhere: any =
    range.from || range.to
      ? { settleDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {};
  // 累计口径只设上界：区间之前的单据是「已发生的事实」，累计类规则必须看见。
  // 未填日期的历史单据也要看见：只按 `settleDate <= to` 取会让「日期为空」的结算单
  // 从累计里凭空消失，分母偏小 → 假超付（2026-10-23 审计 P1-3）。
  const cumulativeWhere: any = range.to
    ? { OR: [{ settleDate: { lte: range.to } }, { settleDate: null }] }
    : {};
  // 付款/手续自带日期，同样只设上界（否则区间末之后的付款会被算进累计）。
  // `payDate` 为空的付款按 `payMonth` 兜底参与判定（rules-payment 里已有月份口径），
  // 因此这里要把它取出来，不能靠日期条件把它过滤掉。
  const paidBy: any = range.to ? { OR: [{ payDate: { lte: range.to } }, { payDate: null }] } : {};
  return {
    contractWhere: { projectId, ...byContractId },
    settlementWhere: { ...scoped, ...windowWhere },
    settlementCumulativeWhere: { ...scoped, ...cumulativeWhere },
    paymentWhere: { ...scoped, ...paidBy },
    procedureWhere: { ...scoped, ...paidBy },
    // 发票/收领单按结算单间接挂项目；指定合同时再收窄一层；累计口径只设上界
    invoiceWhere: {
      projectId,
      settlementId: { not: null },
      settlement: {
        ...byContract,
        ...(range.to ? { settleDate: { lte: range.to } } : {}),
      },
    },
    // 收领单与发票取同一口径：只设上界（原来完全不带日期界，样本里的「收领单」会把
    // 区间末之后的单据也算进去，与发票计数不可比 —— 2026-10-23 审计）
    receiptWhere: {
      projectId,
      settlementId: { not: null },
      ...(chainIds || range.to
        ? {
            settlement: {
              ...byContract,
              ...(range.to ? { settleDate: { lte: range.to } } : {}),
            },
          }
        : {}),
    },
    finalSettlementItemWhere: { finalSettlement: { projectId, ...byContract } },
    // 注意：这是套在 `contract` 关系里的条件，合同主键就叫 `id`（`contractId` 是明细表的列名）
    contractMaterialWhere: { contract: { projectId, ...byContractId } },
  };
}

// ---------------------------------------------------------------------------
// 行 → 规则入参
// ---------------------------------------------------------------------------

/** 一个项目（或一个合同）的原始取数结果，形状由上面 `ANOMALY_SELECT` 决定 */
export interface AnomalyRows {
  contracts: any[];
  /** 区间内结算单（判定对象） */
  settlements: any[];
  /** 截至区间末的结算单（累计口径） */
  cumulativeSettlements: any[];
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
export function buildPaymentAnomalyInput(
  rows: AnomalyRows,
  range?: AnomalyDateRange,
): AnomalyDataset {
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
        parentContractId: c.parentContractId ?? null,
      })),
      settlements: rows.settlements,
      cumulativeSettlements: rows.cumulativeSettlements?.length ? rows.cumulativeSettlements : rows.settlements,
      window: { from: dayOf(range?.from), to: dayOf(range?.to) },
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
