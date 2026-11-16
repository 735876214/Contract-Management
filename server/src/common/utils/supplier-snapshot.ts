/**
 * 签订时点的**供应商快照**（纯函数、零依赖）。
 *
 * 业务口径（2026-10-15 澄清）：**合同正文导出取「签订时快照」**，不是当前主数据。
 * 起因：`template.service.generate()` 原先全取实时值（`sup.bankName / legalPerson / contactPhone`…），
 * 供应商改名或换银行会**改变历史合同再导出**的内容；而系统参数 `supplier.name.sync.history`
 * （默认 `KEEP` = 保留原值）早已声明，却**全仓没有任何读取点**——参数在撒谎。
 *
 * 口径：
 * - `KEEP`（默认）：**快照优先**，快照里缺的字段回退实时（存量合同没有快照 → 行为不变）；
 * - `SYNC`：强制实时（保留给"确实希望历史合同跟着主数据走"的场景，参数从此名副其实）。
 *
 * ⚠️ 铁律 5 不受影响：合同主表仍只存 `supplierId`；快照是**签章时点**的历史留痕，
 * 不是把供应商信息冗余进合同。
 *
 * 保持纯函数（零第三方依赖）；相对 import 须带 `.ts` 后缀（2026-10-17 解除零依赖限制）
 * （`supplierSnapshot.spec.mts` 还会扫 `template.service.ts` 用到的 `sup.*` 字段，
 * 确保这张清单**没有漏项**——漏了就会静默回退实时，那正是本次要消灭的问题）。
 */

/**
 * 需要冻结的供应商字段 = `template.service.generate()` 里读取的全部 `sup.*`。
 * 字段名必须与 `Supplier` 模型一致（spec 会扫源码核对，防止两边漂移）。
 */
export const SUPPLIER_SNAPSHOT_FIELDS = [
  'name',
  'address',
  'bankName',
  'bankAccount',
  'legalPerson',
  'legalPhone',
  'contractAuthPerson',
  'contractAuthPhone',
  'contractAuthIdNo',
  'contactName',
  'contactPhone',
  'contactEmail',
] as const;
// 注：`partyAName` 刻意不在列表里——`Supplier` 没有这个字段（template.service 里对它的读取是死引用，
// 已一并修掉）。往快照里加不存在字段，只会冻结一堆空串。

export type SupplierSnapshot = Record<string, string>;

/** 从供应商记录里取出要冻结的字段（空值归一为空串，便于 JSON 往返） */
export function pickSupplierSnapshot(supplier: Record<string, unknown> | null | undefined): SupplierSnapshot {
  const out: SupplierSnapshot = {};
  for (const k of SUPPLIER_SNAPSHOT_FIELDS) {
    const v = supplier?.[k];
    out[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/** 解析已存的快照 JSON（容忍脏数据：解析失败一律当作"没有快照"） */
export function parseSupplierSnapshot(raw: unknown): SupplierSnapshot | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj as SupplierSnapshot;
  } catch {
    return null;
  }
}

/**
 * 按策略合成最终取值。
 *
 * @param mode `KEEP`（默认）= 快照优先；`SYNC` = 实时优先；未知值一律按 `KEEP`（与"未定即保留原值"一致）
 * @param snapshot 已冻结的快照（可为 null）
 * @param live 当前主数据
 *
 * 逐字段回退：快照里**空串**也视为"未提供"，继续看实时值 —— 签章时供应商还没填开户行、
 * 后来补上了，这种情况应当用补上的值，而不是永久显示空白。
 */
export function mergeSupplierFields(
  mode: unknown,
  snapshot: SupplierSnapshot | null,
  live: SupplierSnapshot,
): SupplierSnapshot {
  const sync = String(mode ?? '').trim().toUpperCase() === 'SYNC';
  const out: SupplierSnapshot = {};
  for (const k of SUPPLIER_SNAPSHOT_FIELDS) {
    const snap = snapshot?.[k] ?? '';
    const cur = live[k] ?? '';
    out[k] = sync ? cur || snap : snap || cur;
  }
  return out;
}
