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
 *
 * **负数口径（业务 2026-11-17）**：数量为负 = 退货/材料调出，参与同物资聚合并按净额
 * 冲减本期结算；只有「数量为空或为 0」才算缺数量。正负完全抵消（净数量 0）的分组
 * 无法用「单价 × 数量」表示，跳过并单独计数，不静默丢。
 */

import { round2, round4 } from '../calc/money.ts';
import { num } from '../calc/numeric.ts';
import { calcPriceWithTax, calcAmount, mulDecimal } from '../calc/amounts.ts';

/** 日报行中参与结算带出的字段（Prisma 查询按这些列 select） */
export interface DailySettlementRow {
  materialBaseId?: string | null;
  materialName?: string | null;
  receiptNo?: string | null;
  settleQty?: unknown;
  priceBeforeTax?: unknown;
  taxRatePct?: unknown;
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
  /** 有物资主数据但结算数量为空/0 的行数（金额无法按数量口径结算，需人工补数量） */
  skippedNoQtyRowCount: number;
  /** 按物资聚合后净数量为 0（收退货互相抵消）而被跳过的行数 */
  skippedNetZeroRowCount: number;
  /** 单价/税率推导异常（税率超出 Decimal(5,2) 可存范围等）的行数 */
  skippedInvalidPriceRowCount: number;
}

/** 与 `SettlementService.normalizeItem()` 完全一致的单价公式（共享原语，4 位精度） */
function normalizePrice(priceBeforeTax: number | null, taxRatePct: number | null) {
  return calcPriceWithTax(priceBeforeTax, taxRatePct, 4) ?? priceBeforeTax;
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
 *   负数是退货/调出，照常参与聚合，净额可为负。
 * - 金额：优先取行上的 `amountBeforeTax` / `amountAfterTax`，缺失时用「单价 × 数量」补算。
 * - 单价：按数量加权平均；税率由加权后的税前/含税单价反推，保证合价与总额一致。
 * - 净数量为 0 的分组（收退货完全抵消）计入 `skippedNetZeroRowCount`，不生成 0 数量明细。
 * - `materialBaseId` 为空的行**无法**形成清单项级明细（`SettlementItem` 必填），
 *   计入 `skippedRowCount` 并由调用方在结算单备注/提示里说明，不静默吞掉。
 */
export function buildSettlementItemsFromDailyRows(
  rows: DailySettlementRow[],
  /**
   * 明细来源标签（业务 2026-11-21）：从收领单明细带出时传「来自收领单」，
   * 让明细备注能看出这一行是从哪条业务链算出来的。默认沿用总日报口径。
   */
  options: { sourceLabel?: string } = {},
): DailyToItemsResult {
  const sourceLabel = options.sourceLabel || '来自总日报';
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
    // 结算明细是**数量口径**：数量为空/0 的行不能形成合价，也不能混进同物资的加权平均。
    // **负数不是缺数量**（业务口径 2026-11-17）：负数 = 退货/材料调出，必须参与聚合，
    // 按净额冲减本期该物资的结算数量与金额。
    if (qty == null || qty === 0) {
      skippedNoQtyRowCount++;
      continue;
    }
    const before = num(r.priceBeforeTax);
    const after = num(r.priceAfterTax);
    const tax = num(r.taxRatePct);
    const amountBefore = num(r.amountBeforeTax) ?? (before != null ? calcAmount(before, qty, 2) : null);
    const amountAfter = num(r.amountAfterTax) ?? (after != null ? calcAmount(after, qty, 2) : null);

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
  let skippedInvalidPriceRowCount = 0;
  let skippedNetZeroRowCount = 0;
  for (const g of groups.values()) {
    // 正负完全抵消（净数量为 0）的分组无法表示成「单价 × 数量」，跳过并计数告警，
    // 不静默丢。负数是退货，照常生成负数量/负金额明细。
    if (round4(g.qty) === 0) {
      skippedNetZeroRowCount += g.count;
      continue;
    }
    // 税前单价：优先加权平均，缺金额时退回最近一条非空单价
    let priceBeforeTax =
      g.sumBefore != null ? round4(g.sumBefore / g.qty) : g.lastBefore;
    const targetAfter = g.sumAfter != null ? round4(g.sumAfter / g.qty) : g.lastAfter;

    // 税率：优先由「含税 / 税前」反推（保证合价与总金额一致），否则用数量加权税率，再否则最近一条
    let taxRatePct: number | null = null;
    if (priceBeforeTax != null && priceBeforeTax > 0 && targetAfter != null) {
      taxRatePct = round2(((targetAfter - priceBeforeTax) / priceBeforeTax) * 100);
    } else if (g.taxQty !== 0) {
      // 退货组的数量与税额同为负，比值仍是正确的加权税率
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
    // 税率列是 Decimal(5,2)（|值| < 1000）；由错误金额反推的异常税率会让 insert 直接 500。
    // 这类行跳过并计数，由调用方提示核对原始日报，不能拖垮整期结算生成。
    if (
      (priceBeforeTax != null && (!Number.isFinite(priceBeforeTax) || priceBeforeTax < 0)) ||
      (taxRatePct != null && (!Number.isFinite(taxRatePct) || Math.abs(taxRatePct) > 999.99))
    ) {
      skippedInvalidPriceRowCount += g.count;
      continue;
    }
    /**
     * 数量先按**落库口径**（4 位）舍入，再参与相乘：否则落库的 `qty` 与算合价用的 `g.qty`
     * 是两份精度不同的数，数量超过 4 位小数时行内会出现「数量 × 单价 ≠ 合价」差 1 分。
     * 乘法一律走共享引擎 `mulDecimal`（十进制精确），不用裸浮点（第 24 轮审计）。
     */
    const qty4 = round4(g.qty);
    const totalWithTax = priceWithTax != null ? mulDecimal(priceWithTax, qty4, 2) : null;
    const source = g.receiptNos.length
      ? `${sourceLabel}（收领单 ${g.receiptNos.join('、')}）`
      : sourceLabel;

    items.push({
      materialBaseId: g.materialBaseId,
      qty: qty4,
      priceBeforeTax,
      taxRatePct,
      priceWithTax,
      totalWithTax,
      remark: source,
      sortOrder: items.length + 1,
    });
  }

  const amount = round2(items.reduce((s, it) => s + (it.totalWithTax ?? 0), 0));
  return {
    items,
    amount,
    skippedRowCount,
    skippedNames,
    skippedNoQtyRowCount,
    skippedNetZeroRowCount,
    skippedInvalidPriceRowCount,
  };
}
