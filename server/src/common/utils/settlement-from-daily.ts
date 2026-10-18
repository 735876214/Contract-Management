/**
 * 总日报 → 结算明细的带出（业务口径 2026-10-18）：
 * **结算单必须在总日报之后生成；结算明细从总日报按物资聚合带出，生成后允许人工修改。**
 *
 * 纯函数（零依赖，仅用 `money.ts` 的 round2/round4），由 `settlement.service.generateForPeriod()`
 * 调用，并由 `server/test/settlementFromDaily.spec.mts` 直接加载锁定。
 *
 * 价格口径：同物资多条日报行（多张收领单/多次进场）按数量加权平均出税前单价与税率；
 * 明细的含税单价/合价与 `SettlementService.normalizeItem()` 使用**同一个公式**，
 * 保证「表头金额 = Σ 明细合价」，不会被两边各算一遍算岔。
 */

import { round2, round4 } from './money.ts';

/** 日报行中参与结算带出的字段（Prisma 查询按这些列 select） */
export interface DailySettlementRow {
  materialBaseId?: string | null;
  materialName?: string | null;
  receiptNo?: string | null;
  settleQty?: unknown;
  priceBeforeTax?: unknown;
  taxRate?: unknown;
  priceAfterTax?: unknown;
  amountBeforeTax?: unknown;
  amountAfterTax?: unknown;
}

/** 结算明细草稿：字段与 `SettlementService.normalizeItem()` 的输入一致 */
export interface SettlementItemDraft {
  materialBaseId: string;
  qty: number;
  priceBeforeTax: number | null;
  taxRatePct: number | null;
  /** 服务端派生，仅供表头金额汇总；落库时由 syncItems 重新按同一公式计算 */
  priceWithTax: number | null;
  totalWithTax: number | null;
  remark: string;
  sortOrder: number;
}

export interface DailyToItemsResult {
  items: SettlementItemDraft[];
  /** 表头金额 = Σ items.totalWithTax（与落库明细同口径） */
  amount: number;
  /** 无物资主数据（materialBaseId 为空）而无法带出的行数 */
  skippedRowCount: number;
  /** 被跳过的行用到的物资名称（去重，最多 5 个） */
  skippedNames: string[];
  /** 有物资主数据但结算数量为空/≤0 的行数（金额无法按数量口径结算，需人工补数量） */
  skippedNoQtyRowCount: number;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 与 `SettlementService.normalizeItem()` 完全一致的单价/合价公式 */
function normalizePrice(priceBeforeTax: number | null, taxRatePct: number | null) {
  const priceWithTax =
    priceBeforeTax != null && taxRatePct != null
      ? Number((priceBeforeTax * (1 + taxRatePct / 100)).toFixed(4))
      : priceBeforeTax;
  return priceWithTax;
}

interface Group {
  materialBaseId: string;
  qty: number;
  sumBefore: number | null;
  sumAfter: number | null;
  sumTaxQty: number;
  taxQty: number;
  lastBefore: number | null;
  lastAfter: number | null;
  lastTax: number | null;
  receiptNos: string[];
  count: number;
}

/**
 * 把一期内的总日报行按物资（`materialBaseId`）聚合成结算明细草稿。
 *
 * - 数量：Σ `settleQty`（空值按 0 计，与旧实现一致；显式 0 仍是 0）。
 * - 金额：优先取行上的 `amountBeforeTax` / `amountAfterTax`，缺失时用「单价 × 数量」补算。
 * - 单价：按数量加权平均；税率由加权后的税前/含税单价反推，保证合价与总额一致。
 * - `materialBaseId` 为空的行**无法**形成清单项级明细（`SettlementItem` 必填），
 *   计入 `skippedRowCount` 并由调用方在结算单备注/提示里说明，不静默吞掉。
 */
export function buildSettlementItemsFromDailyRows(rows: DailySettlementRow[]): DailyToItemsResult {
  const groups = new Map<string, Group>();
  const skippedNames: string[] = [];
  let skippedRowCount = 0;
  let skippedNoQtyRowCount = 0;

  for (const r of rows) {
    const materialBaseId = (r.materialBaseId || '').trim();
    if (!materialBaseId) {
      skippedRowCount++;
      const name = (r.materialName || '').trim();
      if (name && !skippedNames.includes(name) && skippedNames.length < 5) skippedNames.push(name);
      continue;
    }

    const qty = num(r.settleQty);
    // 结算明细是**数量口径**：没有结算数量（空/0/负数）的行不能形成合价，
    // 也不能把它的金额混进同物资的加权平均（否则会算出异常税率/单价）。
    if (qty == null || qty <= 0) {
      skippedNoQtyRowCount++;
      continue;
    }
    const before = num(r.priceBeforeTax);
    const after = num(r.priceAfterTax);
    const tax = num(r.taxRate);
    const amountBefore = num(r.amountBeforeTax) ?? (before != null ? before * qty : null);
    const amountAfter = num(r.amountAfterTax) ?? (after != null ? after * qty : null);

    const g = groups.get(materialBaseId) ?? {
      materialBaseId,
      qty: 0,
      sumBefore: null,
      sumAfter: null,
      sumTaxQty: 0,
      taxQty: 0,
      lastBefore: null,
      lastAfter: null,
      lastTax: null,
      receiptNos: [],
      count: 0,
    };
    g.count++;
    g.qty += qty;
    if (amountBefore != null) g.sumBefore = (g.sumBefore ?? 0) + amountBefore;
    if (amountAfter != null) g.sumAfter = (g.sumAfter ?? 0) + amountAfter;
    if (tax != null) {
      g.sumTaxQty += tax * qty;
      g.taxQty += qty;
    }
    if (before != null) g.lastBefore = before;
    if (after != null) g.lastAfter = after;
    if (tax != null) g.lastTax = tax;
    const no = (r.receiptNo || '').trim();
    if (no && !g.receiptNos.includes(no) && g.receiptNos.length < 5) g.receiptNos.push(no);
    groups.set(materialBaseId, g);
  }

  const items: SettlementItemDraft[] = [];
  for (const g of groups.values()) {
    // 分组阶段已排除无数量行；这里保留防御性判断
    if (g.qty <= 0) continue;
    // 税前单价：优先加权平均，缺金额时退回最近一条非空单价
    let priceBeforeTax =
      g.sumBefore != null ? round4(g.sumBefore / g.qty) : g.lastBefore;
    const targetAfter = g.sumAfter != null ? round4(g.sumAfter / g.qty) : g.lastAfter;

    // 税率：优先由「含税 / 税前」反推（保证合价与总金额一致），否则用数量加权税率，再否则最近一条
    let taxRatePct: number | null = null;
    if (priceBeforeTax != null && priceBeforeTax > 0 && targetAfter != null) {
      taxRatePct = round2(((targetAfter - priceBeforeTax) / priceBeforeTax) * 100);
    } else if (g.taxQty > 0) {
      taxRatePct = round2(g.sumTaxQty / g.taxQty);
    } else {
      taxRatePct = g.lastTax;
    }
    if (priceBeforeTax == null && targetAfter != null) {
      // 只有含税单价时：按 0 税率反推税前，避免明细为空
      priceBeforeTax = targetAfter;
      taxRatePct = taxRatePct ?? 0;
    }

    const priceWithTax = normalizePrice(priceBeforeTax, taxRatePct);
    const totalWithTax = priceWithTax != null ? round2(priceWithTax * g.qty) : null;
    const source = g.receiptNos.length
      ? `来自总日报（收领单 ${g.receiptNos.join('、')}）`
      : '来自总日报';

    items.push({
      materialBaseId: g.materialBaseId,
      qty: round4(g.qty),
      priceBeforeTax,
      taxRatePct,
      priceWithTax,
      totalWithTax,
      remark: source,
      sortOrder: items.length + 1,
    });
  }

  const amount = round2(items.reduce((s, it) => s + (it.totalWithTax ?? 0), 0));
  return { items, amount, skippedRowCount, skippedNames, skippedNoQtyRowCount };
}
