/**
 * 合同物资明细的落库映射（**零依赖纯函数**）。
 *
 * 为什么单独一层：模型抽出来的明细是「10 行 × 7 个字段」的自由文本，
 * 直接写库会把 `￥12.5`、`13%`、空单元格一起写进去；这里统一做数值化、去重、
 * 缺字段补齐，并且**把丢弃的行数报出来**——明细对不上总价是最容易被忽略的问题。
 */

/**
 * 明细来源：`register-fields.ts` 的 `toItems()` 产出的是
 * `{ name, spec, unit, qty, unitPriceWithTax, amountWithTax }`；
 * 这里同时接受 `priceWithTax` / `totalWithTax` 别名与中文列名，避免上游改名就静默丢行。
 */
export interface ExtractItem {
  name?: unknown;
  spec?: unknown;
  unit?: unknown;
  qty?: unknown;
  unitPriceWithTax?: unknown;
  amountWithTax?: unknown;
  priceWithTax?: unknown;
  totalWithTax?: unknown;
  remark?: unknown;
}

export interface MaterialRow {
  name: string;
  spec: string;
  unit: string;
  qty: number | null;
  priceBeforeTax: number | null;
  priceWithTax: number | null;
  /** 增值税百分比（13 = 13%），来自合同税率 */
  taxRatePct: number | null;
  totalWithTax: number | null;
  remark: string | null;
  sortOrder: number;
}

export interface MaterialRowsResult {
  rows: MaterialRow[];
  /** 因为没有名称等原因被丢弃的行数 */
  skipped: number;
  /** 由「数量 × 含税单价」补出来的合价行数 */
  filledTotal: number;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** 取第一个有值的候选键（兼容英文别名与中文列名） */
const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') return v;
  }
  return null;
};
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** `¥1,234.50` / `1234.5元` / `13%` → 数字（取不到返回 null） */
export function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = str(v).replace(/[,，\s]/g, '').replace(/[￥¥元%％]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 默认单位：明细缺单位时不能留空（合同明细表的单位是必填列） */
const DEFAULT_UNIT = '项';

/**
 * 抽取明细 → 可直接写 `ContractMaterial` 的行。
 * - 名称缺失的行丢弃并计入 `skipped`；
 * - 同「名称 + 规格」只保留第一行（避免重复行触发唯一约束）；
 * - 合价缺失时用 `数量 × 含税单价` 补齐（并计入 `filledTotal`）；
 * - 税前单价按合同税率反算，税率未知则留空。
 */
export function materialRowsFromItems(items: unknown, taxRatePct?: number | null): MaterialRowsResult {
  const list: ExtractItem[] = Array.isArray(items) ? (items as ExtractItem[]) : [];
  const rows: MaterialRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let filledTotal = 0;
  const rate = typeof taxRatePct === 'number' && Number.isFinite(taxRatePct) ? taxRatePct : null;

  for (const raw of list) {
    const it = (raw || {}) as Record<string, unknown>;
    const name = str(pick(it, ['name', '物资名称']));
    if (!name) {
      skipped += 1;
      continue;
    }
    const spec = str(pick(it, ['spec', '规格型号', '规格']));
    const key = `${name}||${spec}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);

    const qty = numOf(pick(it, ['qty', '数量']));
    const priceWithTax = numOf(pick(it, ['priceWithTax', 'unitPriceWithTax', '含税单价', '单价']));
    let totalWithTax = numOf(pick(it, ['totalWithTax', 'amountWithTax', '含税合价', '合价', '金额']));
    if (totalWithTax === null && qty !== null && priceWithTax !== null) {
      totalWithTax = round4(qty * priceWithTax);
      filledTotal += 1;
    }
    const priceBeforeTax =
      priceWithTax !== null && rate !== null && rate > -100 ? round4(priceWithTax / (1 + rate / 100)) : null;

    rows.push({
      name,
      spec,
      unit: str(pick(it, ['unit', '计量单位', '单位'])) || DEFAULT_UNIT,
      qty: qty !== null && qty >= 0 ? qty : null,
      priceBeforeTax,
      priceWithTax: priceWithTax !== null && priceWithTax >= 0 ? priceWithTax : null,
      taxRatePct: rate,
      totalWithTax: totalWithTax !== null && totalWithTax >= 0 ? totalWithTax : null,
      remark: str(pick(it, ['remark', '备注'])) || null,
      sortOrder: rows.length + 1,
    });
  }
  return { rows, skipped, filledTotal };
}

/** 明细合价合计（用于与合同总价对账，前端也用它展示） */
export function itemsTotalWithTax(rows: MaterialRow[]): number {
  return round4(rows.reduce((s, r) => s + (r.totalWithTax ?? 0), 0));
}
