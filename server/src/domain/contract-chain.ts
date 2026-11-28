/**
 * **合同链金额口径的单一事实源**（纯函数，只依赖 `@cms/calc`）。
 *
 * 业务口径（2026-10-15 澄清）：
 * > **合同当前金额 = 主合同金额 + 补充协议金额**
 *
 * ⚠️ 为什么不能直接把 `Contract.amount` 相加：补充协议的 `amount` 是**手填自由值**，
 * 涨价/降价场景下它往往被填成"剩余数量的全值"，直接相加会把那部分**重复计入**。
 * 故补充协议参与求和的是 `changeAmount`（**带符号增量**，由 `contract/supplement-delta.ts` 服务端重算）。
 *
 * 链的定义与 `domain/amount-guard.ts` 保持一致：沿 `parentContractId` 上溯到链根（防环，最多 8 层），
 * 链成员 = 链根 + 链根的**直接**补充协议。
 *
 * ⚠️ **主合同金额未填时 `currentAmount` 返回 `null`**（而不是把补充协议增量当成金额）：
 * 与 `amount-guard` 的既有口径一致——"未填"是"不可校验/未知"，不是 0。
 * 这条口径的由来（同类缺陷修过一次）见 .claude/rules/backend-conventions.md 的「金额上限」与「台账」两节。
 *
 * == 为什么在 `server/src/domain/`（2026-11-23 架构评审 P2）==
 * `common/` 从此只放**基础设施**（响应/异常/Excel/导入/日志/存储/权限/where 组合器）；
 * 业务口径的纯函数原语统一放 `server/src/domain/`，规矩三条：
 * 1. **owner 写在文件头 + 登记在 `server/src/constants/metrics.ts`**（本文件 owner = `contract`）；
 * 2. **零 DB、零装饰器、只 import `domain/` 邻居或 `@cms/calc/`**，因此能被 `.mts` spec 与
 *    **AI 只读子域**（`ai/analytics` / `ai/anomaly` / `ai/analysis`）直接加载——后者**不得**依赖
 *    业务模块（检查器判红），这条约束决定了口径原语**不能**放进 `modules/<owner>/`；
 * 3. 需要读表的链 IO 在 `server/src/query/contract-chain-queries.ts`（只读层），
 *    排除草稿的谓词 `notDraft` 在 `server/src/constants/statuses.ts`（与 `paidPaymentWhere` 同一处）。
 *
 * 消费方（改口径前先看这里）：contract / settlement / payment / payment-procedure / ledger /
 * dashboard / final-settlement / ai（analytics·anomaly·analysis·fulfillment）。
 *
 * 相对 import 须带 `.ts` 后缀（.claude/rules/testing.md：零依赖限制已解除，扩展名仍必须写）。
 */

import { sumAmounts } from '@cms/calc';
import { round2 } from '@cms/calc/money';

/** 链计算所需的合同行（`db.contract.findMany` 的 select 结果形状） */
export interface ContractChainRow {
  id: string;
  /** 补充协议指向的主合同；主合同为 `null` */
  parentContractId?: string | null;
  /** 主合同金额（原始值，可能为 null 或空串） */
  amount?: unknown;
  /** 补充协议的**带符号**增量（原始值） */
  changeAmount?: unknown;
}

export interface ChainAmounts {
  /** 链根（主合同）ID；合同不存在时为 `null` */
  rootId: string | null;
  /** 链成员 ID（链根在前，其后为直接补充协议） */
  chainIds: string[];
  /** 主合同金额；未填 → `null` */
  mainAmount: number | null;
  /** 补充协议累计金额（**带符号**求和，降价为负） */
  supplementTotal: number;
  /** 补充协议份数 */
  supplementCount: number;
  /**
   * **合同当前金额** = 主合同金额 + 补充协议累计。
   * 主合同金额未填 → `null`（未知，不可参与比例/上限判定）。
   */
  currentAmount: number | null;
}

/** 与 amount-guard 同款的"未填"判定（`0` 算已填） */
const isFilled = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return Number.isFinite(Number(v));
};

/** 最大上溯深度（防数据自指成环）；链根解析与金额计算共用同一上限 */
export const CHAIN_MAX_DEPTH = 8;

/** 链解析所需的最小合同行形状 */
export interface ContractChainRowLike {
  id: string;
  parentContractId?: string | null;
}

export interface ChainRootResult {
  /** 能到达时是链根 id；断链时是**最后一个可达节点** */
  rootId: string;
  /** 父级不在集合里（数据被改坏 / 跨项目 / 已删除）或超过深度上限 */
  broken: boolean;
}

/** 按 id 建索引（取数一次，链解析在内存里走） */
export function indexContractRows<T extends ContractChainRowLike>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [String(r.id), r]));
}

/**
 * 沿 `parentContractId` 上溯链根（防环）。
 * `rowsById` 必须是**全部合同行**，不能只传已签行——否则父级未签的补充协议会自成一链。
 */
export function resolveChainRoot<T extends ContractChainRowLike>(
  rowsById: Map<string, T>,
  id: string,
): ChainRootResult {
  let cur: T | null = rowsById.get(String(id)) ?? null;
  for (let depth = 0; depth < CHAIN_MAX_DEPTH && cur; depth++) {
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

/**
 * 由「链根行 + 其直接补充协议行」算 ChainAmounts —— **本文件的唯一算式**。
 * 两个导出入口（单合同 `resolveChainAmounts` / 全量 `chainAmountsByRoot`）都走这里，
 * 保证"看板总额"与"台账合同额"永远是同一个数。
 */
function buildChainAmounts(
  rootRow: ContractChainRow,
  supplements: readonly ContractChainRow[],
): ChainAmounts {
  // 求和走 @cms/calc 的 sumAmounts（内部 num() 与上面的 isFilled 同口径：非有限数按未填算 0）
  const supplementTotal = sumAmounts(supplements, (r) => r.changeAmount);
  const mainAmount = isFilled(rootRow.amount) ? round2(Number(rootRow.amount)) : null;
  return {
    rootId: String(rootRow.id),
    chainIds: [String(rootRow.id), ...supplements.map((r) => String(r.id))],
    mainAmount,
    supplementTotal,
    supplementCount: supplements.length,
    currentAmount: mainAmount === null ? null : round2(mainAmount + supplementTotal),
  };
}

/**
 * 由**已取出的合同行集合**算链金额。调用方一次查全（项目内全部合同）后在内存算，
 * 不要按合同逐个查库（那会退化成 N+1）。
 *
 * @param rows 项目内（或至少覆盖整条链）的合同行
 * @param contractId 参与计算的合同（主合同或任一补充协议）
 */
// @metric: contract-chain-amount
export function resolveChainAmounts(rows: ContractChainRow[], contractId: string): ChainAmounts {
  const empty: ChainAmounts = {
    rootId: null,
    chainIds: [],
    mainAmount: null,
    supplementTotal: 0,
    supplementCount: 0,
    currentAmount: null,
  };
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const id = String(contractId ?? '');
  if (!id || !byId.has(id)) return empty;

  // 上溯到链根（防环；断链时停在最后一个可达节点，与旧行为一致）
  const rootId = resolveChainRoot(byId, id).rootId;
  return buildChainAmounts(
    byId.get(rootId)!,
    rows.filter((r) => String(r.parentContractId ?? '') === rootId),
  );
}

/**
 * **一次算全部链**的金额（O(n)）：按 `parentContractId` 分组一次，链根只遍历一遍。
 *
 * 聚合报表（工作台「合同总额」、类型分布、台账合计）必须用它——
 * 逐合同调 `resolveChainAmounts` 会退化成 O(n²)（每个合同都全表 filter 一遍）。
 *
 * 断链（父行缺失/跨项目/已删）按「最后一个可达节点为根」处理，与 `resolveChainAmounts` 同口径；
 * 主合同金额未填的链返回 `currentAmount: null`（未知，调用方按 0 参与合计并另计条数）。
 */
export function chainAmountsByRoot(rows: readonly ContractChainRow[]): Map<string, ChainAmounts> {
  const byId = indexContractRows(rows);
  const childrenByParent = new Map<string, ContractChainRow[]>();
  for (const r of rows) {
    const parentId = String(r.parentContractId ?? '');
    if (!parentId) continue;
    const list = childrenByParent.get(parentId);
    if (list) list.push(r);
    else childrenByParent.set(parentId, [r]);
  }
  const out = new Map<string, ChainAmounts>();
  for (const r of rows) {
    const { rootId } = resolveChainRoot(byId, String(r.id));
    if (out.has(rootId)) continue;
    const rootRow = byId.get(rootId);
    if (!rootRow) continue;
    out.set(rootId, buildChainAmounts(rootRow, childrenByParent.get(rootId) ?? []));
  }
  return out;
}
