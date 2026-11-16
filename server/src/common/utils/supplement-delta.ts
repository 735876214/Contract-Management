/**
 * **补充协议「带符号增量」的服务端重算**（纯函数、零依赖）。
 *
 * 业务口径（2026-10-15 澄清）：变更需要**结构化**，且
 * **合同当前金额 = 主合同金额 + 补充协议金额**（见 `contract-chain.ts`）。
 *
 * 为什么必须由服务端按清单重算、而不是取用户手填的 `Contract.amount`：
 * 补充协议在界面上是按「补充协议类型 + 清单行」录入的，而 `amount` 是个自由填写字段。
 * 涨价/降价时，用户的直觉是把"剩余数量 × 新单价"填成金额 —— 但主合同里**那部分数量的
 * 原值已经计过一次**，直接相加会把剩余数量重复计入，算出的"合同当前金额"偏大。
 * 真正要加的是**差额**（Δ），减项则为负。
 *
 * 与前端文档口径一致：`SupplementDraft.tsx` 的 `buildSupplementData()` 里
 * 「新增合同金额」用的就是同一套算法（原合同剩余数量 × 价差 / 新增数量 × 原价 /
 * 新增物资全额），本模块是它在**服务端**的对应实现。
 *
 * 保持纯函数（零第三方依赖）；相对 import 须带 `.ts` 后缀（2026-10-17 解除零依赖限制，见 .claude/rules/testing.md）。
 */

/** 参与计算的清单行（`ContractMaterial` 的取值面） */
export interface DeltaMaterialRow {
  /** 物资主数据 ID（补充协议与主合同按它配对） */
  materialBaseId?: string | null;
  /** 数量（补充协议行=本次变更数量，主合同行=原数量） */
  qty?: unknown;
  /** 含税单价（合同金额一栏都是含税口径，故价差也取含税价） */
  priceWithTax?: unknown;
  /** 含税合价（新增物资全额时用） */
  totalWithTax?: unknown;
}

export interface SupplementDelta {
  /** 带符号金额增量：增项为正、减项为负 */
  amount: number;
  /** 带符号数量增量 */
  qty: number;
  /** 命中的算法（便于日志与排查） */
  basis: 'PRICE_DIFF' | 'QTY_FULL' | 'ITEM_FULL' | 'NONE';
  /** 价格类变更中未能在主合同里配到原物资的行数（按"新增物资全额"计） */
  unmatchedRows: number;
}

const num = (v: unknown) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Number((Number(n) || 0).toFixed(2));

/**
 * 计算补充协议带来的带符号增量。
 *
 * | 类型 | 金额增量 | 数量增量 |
 * |---|---|---|
 * | `PRICE_UP` / `PRICE_DOWN` | Σ (补充含税单价 − 原含税单价) × 补充数量 | 0（改价不改量） |
 * | `QTY_ADD` | Σ 原含税单价 × 新增数量 | Σ 新增数量 |
 * | `ITEM_ADD` | Σ 新增物资含税合价 | Σ 新增数量 |
 * | 其他（`OTHER` 富文本等） | 0 | 0 |
 *
 * 价格类变更中**主合同查不到同物资**的行按 `ITEM_ADD` 处理（全额计入）——
 * 静默丢弃会让"当前金额"偏小，那是更坏的方向。
 */
export function computeSupplementDelta(input: {
  typeCode?: string | null;
  /** 补充协议自己的清单行（本次变更量） */
  suppRows: DeltaMaterialRow[];
  /** 主合同清单行（取原单价/原物资） */
  parentRows: DeltaMaterialRow[];
}): SupplementDelta {
  const type = String(input.typeCode ?? '').toUpperCase();
  const suppRows = input.suppRows ?? [];
  const parentByMaterial = new Map(
    (input.parentRows ?? [])
      .filter((r) => r?.materialBaseId)
      .map((r) => [String(r.materialBaseId), r] as const),
  );

  if (type === 'PRICE_UP' || type === 'PRICE_DOWN') {
    let amount = 0;
    let unmatched = 0;
    for (const r of suppRows) {
      const parent = r?.materialBaseId ? parentByMaterial.get(String(r.materialBaseId)) : undefined;
      if (!parent) {
        // 主合同里没有这个物资 → 按新增物资全额计（不静默丢弃）
        amount += num(r?.totalWithTax) || num(r?.priceWithTax) * num(r?.qty);
        unmatched += 1;
        continue;
      }
      amount += (num(r?.priceWithTax) - num(parent.priceWithTax)) * num(r?.qty);
    }
    return { amount: round2(amount), qty: 0, basis: 'PRICE_DIFF', unmatchedRows: unmatched };
  }

  if (type === 'QTY_ADD') {
    let amount = 0;
    let qty = 0;
    for (const r of suppRows) {
      const parent = r?.materialBaseId ? parentByMaterial.get(String(r.materialBaseId)) : undefined;
      // 原合同单价为准；查不到则退回该行自己的单价（至少不是 0）
      const unitPrice = parent ? num(parent.priceWithTax) : num(r?.priceWithTax);
      amount += unitPrice * num(r?.qty);
      qty += num(r?.qty);
    }
    return { amount: round2(amount), qty: round2(qty), basis: 'QTY_FULL', unmatchedRows: 0 };
  }

  if (type === 'ITEM_ADD') {
    let amount = 0;
    let qty = 0;
    for (const r of suppRows) {
      amount += num(r?.totalWithTax) || num(r?.priceWithTax) * num(r?.qty);
      qty += num(r?.qty);
    }
    return { amount: round2(amount), qty: round2(qty), basis: 'ITEM_FULL', unmatchedRows: 0 };
  }

  /** 富文本补充协议 / 未指定类型：不产生金额变更（不计入合同当前金额） */
  return { amount: 0, qty: 0, basis: 'NONE', unmatchedRows: 0 };
}
