/**
 * 金额上限校验：防超结 / 防超付 —— docs/09 §四。
 *
 * **零 import 依赖**（不引 Prisma / Nest），可直接被 `server/test/*.spec.mts` 加载，
 * 也可传入 mock db 单测合同链口径。
 *
 * 口径（与 docs/09 §四一致）：
 * - 「合同链金额」= 主合同 amount + 其全部补充协议 amount 之和
 * - 「累计结算」= 该链上 `Settlement.actualAmount`（回退 `amount`）之和，**排除草稿**（`DRAFT` 是唯一未提交态）
 * - 「累计付款」= 该链上 `PaymentRecord.amount` 之和
 *
 * ⚠️ 注意 `statusCode != 'DRAFT'` 在 SQL 里会连带排除 NULL（三值逻辑），
 * 故排除条件一律写成 `OR: [{ statusCode: null }, { statusCode: { not: 'DRAFT' } }]`。
 */

/** 超限策略：BLOCK 拦截 / WARN 仅提示 / OFF 不校验 */
export type OverAmountPolicy = 'BLOCK' | 'WARN' | 'OFF';

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 数值归一：非法/空 → 0（避免 NaN 渗入金额比较） */
const toNum = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 策略归一：未知值一律按最保守的 WARN（不阻断），避免配置写错导致结算/付款被卡死 */
export function normalizePolicy(raw: unknown): OverAmountPolicy {
  const v = String(raw ?? '').trim().toUpperCase();
  return v === 'BLOCK' || v === 'OFF' ? v : 'WARN';
}

export interface OverAmountInput {
  /** 上限（合同链金额 / 累计结算额）；null / undefined = 无上限（如合同未填金额） */
  limit: number | null | undefined;
  /** 已占用（同链上已提交的累计金额；调用方负责排除草稿与自身） */
  used: number | null | undefined;
  /** 本次金额 */
  current: number | null | undefined;
  /** 业务名称，用于消息（如「结算」「付款」） */
  label?: string;
}

export interface OverAmountResult {
  exceeded: boolean;
  /** 超出金额；未超时为 0 */
  overBy: number;
  limit: number;
  used: number;
  current: number;
  /** 本次之后累计 = used + current */
  total: number;
  message: string;
}

/**
 * 判断「已占用 + 本次」是否超过上限。纯函数，不抛错（由调用方按策略决定拦截或提示）。
 * - 上限为 null/undefined → 视为无上限（exceeded=false）
 * - 比较前统一 round 到 2 位小数，规避浮点误差（0.1+0.2 类问题）
 */
export function checkOverAmount(input: OverAmountInput): OverAmountResult {
  const used = round2(toNum(input.used));
  const current = round2(toNum(input.current));
  const total = round2(used + current);
  const hasLimit = input.limit !== null && input.limit !== undefined && Number.isFinite(Number(input.limit));
  const limit = hasLimit ? round2(Number(input.limit)) : 0;
  const label = input.label ?? '本次金额';

  if (!hasLimit) {
    return { exceeded: false, overBy: 0, limit, used, current, total, message: '' };
  }
  const overBy = round2(total - limit);
  const exceeded = overBy > 0;
  const message = exceeded
    ? `累计${label}将达 ¥${total.toFixed(2)}，超过上限 ¥${limit.toFixed(2)}（其中已发生 ¥${used.toFixed(2)}，本次 ¥${current.toFixed(2)}，超出 ¥${overBy.toFixed(2)}）`
    : '';
  return { exceeded, overBy, limit, used, current, total, message };
}

/* ------------------------------------------------------------------ *
 * 合同链口径（需要 db，传 PrismaClient 或 mock；本文件不 import 任何类型）
 * ------------------------------------------------------------------ */

/** 沿 `parentContractId` 上溯取链根（主合同）ID；防环（最多 8 层） */
export async function contractChainRootId(db: any, contractId: string): Promise<string | null> {
  let id = String(contractId ?? '');
  if (!id) return null;
  for (let depth = 0; depth < 8; depth++) {
    const c = await db.contract.findUnique({ where: { id }, select: { id: true, parentContractId: true } });
    if (!c) return depth === 0 ? null : id;
    if (!c.parentContractId) return c.id;
    id = c.parentContractId;
  }
  return id;
}

/** 链上全部合同 ID = 链根 + 其直接补充协议 */
export async function contractChainIds(db: any, contractId: string): Promise<string[]> {
  const rootId = await contractChainRootId(db, contractId);
  if (!rootId) return [];
  const children = await db.contract.findMany({
    where: { parentContractId: rootId },
    select: { id: true },
  });
  return [rootId, ...children.map((c: any) => c.id)];
}

/** 合同链金额 = 链根 + 补充协议 的 amount 之和（金额未填按 0） */
export async function contractChainAmount(db: any, contractId: string): Promise<number> {
  const ids = await contractChainIds(db, contractId);
  if (!ids.length) return 0;
  const rows = await db.contract.findMany({ where: { id: { in: ids } }, select: { amount: true } });
  return round2(rows.reduce((s: number, r: any) => s + toNum(r.amount), 0));
}

/** 排除草稿的 where 片段（见文件头关于 NULL 的说明） */
const notDraft = { OR: [{ statusCode: null }, { statusCode: { not: 'DRAFT' } }] };

/** 链上累计结算额（`actualAmount` 回退 `amount`，排除草稿与 excludeId 自身） */
export async function chainSettledTotal(db: any, contractId: string, excludeId?: string): Promise<number> {
  const ids = await contractChainIds(db, contractId);
  if (!ids.length) return 0;
  const rows = await db.settlement.findMany({
    where: { contractId: { in: ids }, ...notDraft, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { actualAmount: true, amount: true },
  });
  return round2(rows.reduce((s: number, r: any) => s + toNum(r.actualAmount ?? r.amount), 0));
}

/**
 * 链上累计付款额。
 * - `excludeId`：排除自身（编辑场景）
 * - `excludeStatuses`：排除**不构成实际出资**的状态（如 `FAILED 付款失败` / `REFUNDED 已退款`），
 *   否则一笔失败记录会虚增"累计付款"，在 BLOCK 策略下误挡后续正常付款
 */
export async function chainPaidTotal(
  db: any,
  contractId: string,
  excludeId?: string,
  excludeStatuses: string[] = [],
): Promise<number> {
  const ids = await contractChainIds(db, contractId);
  if (!ids.length) return 0;
  const rows = await db.paymentRecord.findMany({
    where: { contractId: { in: ids }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { amount: true, statusCode: true },
  });
  return round2(
    rows
      .filter((r: any) => !excludeStatuses.includes(String(r.statusCode ?? '')))
      .reduce((s: number, r: any) => s + toNum(r.amount), 0),
  );
}
