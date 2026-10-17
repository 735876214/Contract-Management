/**
 * 分包单位领用月度汇总的**派生口径**纯函数（零依赖，可被 `.mts` spec 加载）。
 *
 * 业务口径（附件需求 2026-10-17 第二批，图一/图二/图三）：
 * - 图二（数据基础）：本期净领 = 本期领用 − 本期退库；上期末累计 = 上一期的「至本期末累计」；
 * - 图三（甲供材节超分析）：
 *   - 扣款单价 = 单价 × (1 + 20%)；
 *   - 设计量小计（含损耗）= 至本期末开累 × (1 + 损耗率/100)；
 *   - 至本期末开累用量（实耗分子 J）= 上期末累计 + 本期净领；
 *   - 实耗 = 开累用量 − 库存盘点；
 *   - 节超(−)超(+) = 实耗 − 设计量小计（正 = 超耗；样表混凝土行 I=0、实耗 4、M=4、扣款 = 419.41×4）；
 *   - 结算扣款 = 扣款单价 × 节超（节超 ≤ 0 → 0，节约不扣款）；
 *   - 实际损耗率 = (实耗 − 设计量小计) ÷ 设计量小计。
 *
 * ⚠️ **三态契约**（与 ledger-derived 一致）：任何输入未填（null/undefined）→ 结果 null，
 * 不兜成 0；显式 0 是真实 0，照常参与计算。
 */

export interface DeriveReceivingInput {
  /** 上期末累计（由 service 按期链式推出；首期 0） */
  prevCum?: number | null;
  /** 本期领用数量（收领单聚合；未聚合到 → null） */
  receivedQty?: number | null;
  /** 本期退库数量（手填） */
  returnQty?: number | null;
  /** 本月库存盘点数量（手填） */
  stockTakeQty?: number | null;
  /** 设计量 · 至本期末开累（手填） */
  designQtyCum?: number | null;
  /** 损耗率 %（手填，如 5 表示 5%） */
  lossRate?: number | null;
  /** 平均单价 */
  unitPrice?: number | null;
}

export interface DerivedReceivingRow {
  /** 本期净领 = 领用 − 退库 */
  netQty: number | null;
  /** 上期末累计 + 本期净领 = 至本期末开累用量（图三 J） */
  usedCum: number | null;
  /** 实耗 = 开累用量 − 库存盘点（图三 L） */
  actualUse: number | null;
  /** 扣款单价 = 单价 × 1.2（图三 F） */
  deductPrice: number | null;
  /** 设计量小计（含损耗）= 开累 × (1 + 损耗率/100)（图三 I） */
  designSubtotal: number | null;
  /** 节(−)超(+) = 实耗 − 设计量小计（图三 M；正 = 超耗） */
  saveOver: number | null;
  /** 结算扣款 = 扣款单价 × 节超，节约/未超 → 0（图三 N） */
  deductAmount: number | null;
  /** 实际损耗率 = (实耗 − 设计量小计) ÷ 设计量小计（图三 O） */
  actualLossRate: number | null;
}

/** 数值清洗：null/undefined/''/NaN → null，否则 Number */
function n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** 四舍五入到指定位数；入参 null → null */
function r(v: number | null, digits: number): number | null {
  if (v == null) return null;
  const p = Math.pow(10, digits);
  return Math.round(v * p) / p;
}

export function deriveReceivingRow(input: DeriveReceivingInput): DerivedReceivingRow {
  const prevCum = n(input.prevCum);
  const received = n(input.receivedQty);
  const ret = n(input.returnQty);
  const stock = n(input.stockTakeQty);
  const design = n(input.designQtyCum);
  const loss = n(input.lossRate);
  const price = n(input.unitPrice);

  // 净领：领用未填 → null（不谎称 0）；领用有值时退库未填按 0（需求原文：净领 = 领用 − 退库）
  const netQty = received == null ? null : r(received - (ret ?? 0), 3);
  // 开累用量：上期末累计 + 本期净领（两者都未知 → null）
  const usedCum = prevCum == null && netQty == null ? null : r((prevCum ?? 0) + (netQty ?? 0), 3);
  // 实耗 = 开累用量 − 盘点（盘点未填按 0：没盘点不代表没耗用）
  const actualUse = usedCum == null ? null : r(usedCum - (stock ?? 0), 3);
  // 扣款单价 = 单价 × 1.2
  const deductPrice = price == null ? null : r(price * 1.2, 4);
  // 设计量小计 = 开累 × (1 + 损耗率/100)
  const designSubtotal = design == null ? null : r(design * (1 + (loss ?? 0) / 100), 3);
  // 节(−)超(+) = 实耗 − 设计量小计（样表口径：超耗为正）
  const saveOver = designSubtotal == null && actualUse == null ? null : r((actualUse ?? 0) - (designSubtotal ?? 0), 3);
  // 结算扣款：只有「超」（saveOver > 0）才扣；节约/持平 → 0；口径未知 → null
  const deductAmount =
    saveOver == null || deductPrice == null ? null : saveOver > 0 ? r(saveOver * deductPrice, 2) : 0;
  // 实际损耗率 = (实耗 − 设计小计) ÷ 设计小计（分母未知/为 0 → null）
  // 实际损耗率 = (实耗 − 设计小计) ÷ 设计小计（样表口径：超耗为正；分母未知/为 0 → null）
  const actualLossRate =
    designSubtotal == null || designSubtotal === 0 || actualUse == null
      ? null
      : r((actualUse - designSubtotal) / designSubtotal, 4);

  return { netQty, usedCum, actualUse, deductPrice, designSubtotal, saveOver, deductAmount, actualLossRate };
}

/**
 * 平均单价 = Σ税前总价 ÷ Σ数量（图三口径：来自该分包单位有价格的材料的平均单价）。
 * 聚合输入为空（无记录/Σ数量 0）→ null。
 */
export function averageUnitPrice(totalPrice: number | null | undefined, totalQty: number | null | undefined): number | null {
  const p = n(totalPrice);
  const q = n(totalQty);
  if (p == null || q == null || q === 0) return null;
  return r(p / q, 4);
}

/**
 * 加权单价 = Σ(数量×单价) ÷ Σ数量 —— 月度盈亏分析**汇总表**跨劳务队合并同一材料时用
 * （附件需求 2026-10-17 第三批图一）。任一队单价未知：该队的数量仍进分母、金额只累已知队
 * （保守口径——不虚构缺失单价）；Σ数量 0 / 全部未知 → null。
 */
export function weightedUnitPrice(
  rows: Array<{ qty: number | null | undefined; unitPrice: number | null | undefined }>,
): number | null {
  let totalQty = 0;
  let totalAmount = 0;
  let known = false;
  for (const row of rows) {
    const q = n(row.qty);
    const p = n(row.unitPrice);
    if (q == null) continue;
    totalQty += q;
    if (p != null) {
      totalAmount += q * p;
      known = true;
    }
  }
  if (!known || totalQty === 0) return null;
  return r(totalAmount / totalQty, 4);
}
