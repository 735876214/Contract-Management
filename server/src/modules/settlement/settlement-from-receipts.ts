/**
 * 收领单 → 结算明细的带出（业务口径 2026-11-21）：
 * **结算明细的来源从「只有总日报行」扩到「收领单明细优先、日报行兜底」。**
 *
 * 为什么需要它：结算单与收领单早已能挂接（`ReceiptOrder.settlementId`），
 * 但明细只在「按月自动生成结算单」这条路径上从总日报带出；人工建的结算单即使挂上了
 * 收领单，`SettlementItem` 也永远是空的 —— 量级闸门（`checkOverSettlementQty`）、
 * 合同链已结算量（`chainSettledItemQty`）、总结算单快照全都拿不到数据。
 *
 * 取数优先级（每张收领单独立判定，不混算，避免同一笔数量被算两遍）：
 * 1. 该收领单有明细行且有 `materialId`（物资主数据）→ 用**明细行**：数量取 `receivedQty`（实收），
 *    税前单价/税率取明细，含税单价取明细的 `priceWithTax` 快照，含税金额取 `totalPrice`；
 * 2. 该收领单没有可用明细（老单据只推了日报、或明细没选物资）→ 退回**它推出去的总日报行**；
 * 3. 两者都没有 → 该单不产生明细，单号进 `ordersWithoutItems`，由调用方提示，不静默丢。
 *
 * 价格/税率/金额算法**不在这里重写**：把两种来源统一映射成 `DailySettlementRow[]`
 * 后交给 `buildSettlementItemsFromDailyRows()`，保证「明细合价 = Σ 行金额」与自动生成路径
 * 用的是同一个公式（单一事实源，见 `settlement-from-daily.ts` 注释）。
 *
 * 纯函数（零 Prisma 依赖），由 `settlement.service` 调用并由
 * `server/test/settlementFromReceipts.spec.mts` 直接加载锁定。
 */

import {
  buildSettlementItemsFromDailyRows,
  type DailySettlementRow,
  type DailyToItemsResult,
} from './settlement-from-daily.ts';

/** 收领单明细中参与结算带出的字段（Prisma 查询按这些列 select） */
export interface ReceiptDetailRow {
  /** 物资主数据 ID（列名 `materialId`，与 `SettlementItem.materialBaseId` 同源） */
  materialId?: string | null;
  /** 实收数量（结算量口径） */
  receivedQty?: unknown;
  priceBeforeTax?: unknown;
  taxRatePct?: unknown;
  /** 明细上的综合单价快照（= 税前 × (1+税率)），仅用于金额口径兜底 */
  priceWithTax?: unknown;
  /** 明细上的综合总价快照（= 实收 × 综合单价） */
  totalPrice?: unknown;
}

export interface ReceiptOrderSource {
  id?: string;
  orderNo?: string | null;
  details?: ReceiptDetailRow[] | null;
  /** 该收领单推送出去的总日报行（明细缺失时的兜底来源） */
  dailyRows?: DailySettlementRow[] | null;
}

export interface ReceiptToItemsResult extends DailyToItemsResult {
  /** 参与带出的收领单张数 */
  receiptOrderCount: number;
  /** 来自收领单明细的原始行数 */
  detailRowCount: number;
  /** 明细不可用、退回总日报行的收领单张数 */
  dailyFallbackOrderCount: number;
  /** 两种来源都没带出任何行的收领单编号（去重，最多 5 个） */
  ordersWithoutItems: string[];
}

/** 收领单明细 → 与总日报行同构的行（交给同一套聚合/定价逻辑） */
function detailToDailyRow(d: ReceiptDetailRow, orderNo: string | null): DailySettlementRow | null {
  const materialBaseId = (d.materialId || '').trim();
  if (!materialBaseId) return null;
  return {
    materialBaseId,
    // 明细上没有物资名称快照列，名称由 materialBase 关联补（聚合函数只把它用于跳过提示）
    materialName: null,
    receiptNo: orderNo,
    settleQty: d.receivedQty,
    priceBeforeTax: d.priceBeforeTax,
    taxRatePct: d.taxRatePct,
    priceAfterTax: d.priceWithTax,
    // 金额口径：明细里存了综合总价就直传，否则让聚合函数按「单价 × 数量」补算
    amountAfterTax: d.totalPrice,
  };
}

/**
 * 把「本期挂在该结算单上的收领单（含明细）」聚合成结算明细草稿。
 *
 * - 同一物资跨多张收领单：数量求和、单价按数量加权（与自动生成路径完全一致）；
 * - 数量为负（退货/调出）照常参与聚合，净额为负也保留；
 * - 明细缺物资主数据、数量为空/为 0、净数量为 0、单价/税率越界的分组按原有口径
 *   计入各自的 `skipped*` 计数，由调用方提示，不静默丢。
 */
export function buildSettlementItemsFromReceiptOrders(
  orders: ReceiptOrderSource[],
): ReceiptToItemsResult {
  const rows: DailySettlementRow[] = [];
  const ordersWithoutItems: string[] = [];
  let detailRowCount = 0;
  let dailyFallbackOrderCount = 0;

  for (const o of Array.isArray(orders) ? orders : []) {
    const orderNo = (o.orderNo || '').trim() || null;
    const fromDetails = (o.details || [])
      .map((d) => detailToDailyRow(d, orderNo))
      .filter((r): r is DailySettlementRow => r != null);

    if (fromDetails.length) {
      rows.push(...fromDetails);
      detailRowCount += fromDetails.length;
      continue;
    }

    const fromDaily = (o.dailyRows || []).filter((r) => (r.materialBaseId || '').trim());
    if (fromDaily.length) {
      rows.push(...fromDaily);
      dailyFallbackOrderCount += 1;
      continue;
    }

    // 明细与日报都没有物资主数据：这张单带不出清单项级明细
    const key = orderNo || (o.id ? `收领单 ${o.id}` : '收领单');
    if (ordersWithoutItems.length < 5 && !ordersWithoutItems.includes(key)) ordersWithoutItems.push(key);
  }

  const built = buildSettlementItemsFromDailyRows(rows, { sourceLabel: '来自收领单' });
  return {
    ...built,
    receiptOrderCount: Array.isArray(orders) ? orders.length : 0,
    detailRowCount,
    dailyFallbackOrderCount,
    ordersWithoutItems,
  };
}
