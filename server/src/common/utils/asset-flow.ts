/**
 * 物资进出场方向与汇总（业务口径 2026-10-18：进出场**只做物资**）。
 *
 * 不建新表：进场 = 采购/调入，出场 = 调出/处置（出售/出租），
 * 「调入费/维保费」只有金额、没有数量，**不计入进出场数量**。
 * 纯函数（零依赖，仅用 `money.ts`），由 `server/test/assetFlow.spec.mts` 锁定。
 */

import { round2, round4 } from './money.ts';

export const ASSET_FLOW_DIRECTION = {
  IN: 'IN',
  OUT: 'OUT',
  FEE: 'FEE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type AssetFlowDirection = (typeof ASSET_FLOW_DIRECTION)[keyof typeof ASSET_FLOW_DIRECTION];

/** 进场来源（资产台账 dict `asset_ledger_source`） */
export const ASSET_IN_SOURCES = ['PURCHASE', 'TRANSFER_IN'] as const;
/** 出场来源 */
export const ASSET_OUT_SOURCES = ['TRANSFER_OUT', 'DISPOSE_SALE', 'DISPOSE_RENT'] as const;
/** 纯费用来源（不构成进出场数量） */
export const ASSET_FEE_SOURCES = ['TRANSFER_IN_FEE', 'MAINTENANCE'] as const;

export function assetDirectionOf(sourceCode: string | null | undefined): AssetFlowDirection {
  const code = String(sourceCode ?? '').toUpperCase();
  if ((ASSET_IN_SOURCES as readonly string[]).includes(code)) return ASSET_FLOW_DIRECTION.IN;
  if ((ASSET_OUT_SOURCES as readonly string[]).includes(code)) return ASSET_FLOW_DIRECTION.OUT;
  if ((ASSET_FEE_SOURCES as readonly string[]).includes(code)) return ASSET_FLOW_DIRECTION.FEE;
  return ASSET_FLOW_DIRECTION.UNKNOWN;
}

export interface AssetFlowRow {
  sourceCode?: string | null;
  qty?: unknown;
  totalAmount?: unknown;
}

export interface AssetFlowSummary {
  inQty: number | null;
  inAmount: number | null;
  outQty: number | null;
  outAmount: number | null;
  feeAmount: number | null;
  /** 未知来源（历史数据/未登记字典）单独统计，不混入进出场 */
  unknownQty: number | null;
  unknownAmount: number | null;
  bySource: { sourceCode: string; direction: AssetFlowDirection; qty: number | null; amount: number | null }[];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

interface Bucket {
  qty: number;
  amount: number;
  hasQty: boolean;
  hasAmount: boolean;
}

const emptyBucket = (): Bucket => ({ qty: 0, amount: 0, hasQty: false, hasAmount: false });

/** 按来源汇总进出场数量与金额（金额取台账 `totalAmount` = 数量 × 单价） */
export function summarizeAssetFlow(rows: AssetFlowRow[]): AssetFlowSummary {
  const bySource = new Map<string, Bucket>();
  for (const r of rows) {
    const code = String(r.sourceCode ?? '').toUpperCase() || 'UNKNOWN';
    const hit = bySource.get(code) ?? emptyBucket();
    const q = num(r.qty);
    const a = num(r.totalAmount);
    if (q != null) {
      hit.qty += q;
      hit.hasQty = true;
    }
    if (a != null) {
      hit.amount += a;
      hit.hasAmount = true;
    }
    bySource.set(code, hit);
  }

  const buckets: Record<string, Bucket> = {
    IN: emptyBucket(),
    OUT: emptyBucket(),
    FEE: emptyBucket(),
    UNKNOWN: emptyBucket(),
  };
  const sources: AssetFlowSummary['bySource'] = [];
  for (const [sourceCode, v] of bySource) {
    const direction = assetDirectionOf(sourceCode);
    sources.push({
      sourceCode,
      direction,
      qty: v.hasQty ? round4(v.qty) : null,
      amount: v.hasAmount ? round2(v.amount) : null,
    });
    const b = buckets[direction] ?? buckets.UNKNOWN;
    if (v.hasQty) {
      b.qty += v.qty;
      b.hasQty = true;
    }
    if (v.hasAmount) {
      b.amount += v.amount;
      b.hasAmount = true;
    }
  }

  const out = (b: Bucket) => ({
    qty: b.hasQty ? round4(b.qty) : null,
    amount: b.hasAmount ? round2(b.amount) : null,
  });
  const i = out(buckets.IN);
  const o = out(buckets.OUT);
  const fee = out(buckets.FEE);
  const unk = out(buckets.UNKNOWN);
  sources.sort((a, b) => a.sourceCode.localeCompare(b.sourceCode));
  return {
    inQty: i.qty,
    inAmount: i.amount,
    outQty: o.qty,
    outAmount: o.amount,
    feeAmount: fee.amount,
    unknownQty: unk.qty,
    unknownAmount: unk.amount,
    bySource: sources,
  };
}
