/**
 * AI · **合同链根解析（纯函数，单一实现）**。
 *
 * 从 `analysis/scm-facts.ts` 提取：供应链全景与经营数据助手必须用同一套「上溯链根 /
 * 断链判定」，否则同一份合同在两条链路里会被切成不同的链、金额重复或漏计。
 *
 * 规则（与 `common/utils/contract-chain.ts` 的 `CHAIN_MAX_DEPTH` 对齐）：
 * - 父级不在取数集合里（数据被手工改坏 / 跨项目 / 已删除）→ **断链**，`broken: true`，不猜；
 * - 追到深度上限还没到根（成环/层级异常）→ 按断链处理（拿中途节点当根会把一条链拆成多条）。
 */

export interface ContractChainRowLike {
  id: string;
  parentContractId?: string | null;
}

/** 最大上溯深度（与 `contract-chain.ts` 的 `CHAIN_MAX_DEPTH` 同值：防数据自指成环） */
export const CHAIN_DEPTH_LIMIT = 8;

export interface ChainRootResult {
  rootId: string;
  broken: boolean;
}

/** 按 id 建索引（取数一次，链解析多用在内存里走） */
export function indexContractRows<T extends ContractChainRowLike>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [String(r.id), r]));
}

/** 上溯链根；`rowsById` 必须是**全部合同行**（不能只是已签行，否则父级未签的补充协议会自成一链） */
export function resolveChainRoot<T extends ContractChainRowLike>(
  rowsById: Map<string, T>,
  id: string,
): ChainRootResult {
  let cur: T | null = rowsById.get(String(id)) ?? null;
  for (let depth = 0; depth < CHAIN_DEPTH_LIMIT && cur; depth++) {
    const parentId = cur.parentContractId ? String(cur.parentContractId) : '';
    if (!parentId) return { rootId: String(cur.id), broken: false };
    const parent = rowsById.get(parentId);
    if (!parent) return { rootId: String(cur.id), broken: true };
    cur = parent;
  }
  return { rootId: String(cur?.id ?? id), broken: true };
}

/** 每条链有几行合同（链根 + 补充协议）：区分「有补充协议」与「单份合同」 */
export function chainRowCountByRoot<T extends ContractChainRowLike>(rows: readonly T[]): Map<string, number> {
  const index = indexContractRows(rows);
  const out = new Map<string, number>();
  for (const row of rows) {
    const { rootId, broken } = resolveChainRoot(index, String(row.id));
    if (broken) continue;
    out.set(rootId, (out.get(rootId) ?? 0) + 1);
  }
  return out;
}
