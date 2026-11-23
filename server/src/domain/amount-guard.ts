/**
 * 金额上限**判定**：防超结 / 防超付 —— .claude/rules/backend-conventions.md「金额上限」。
 *
 * **零 import 依赖**（不引 Prisma / Nest），可直接被 `server/test/*.spec.mts` 加载。
 *
 * 本文件只做**不碰数据库**的事：策略归一 + 「已占用 + 本次」与上限的比较。
 * 链口径与所需的 db 查询（合同当前金额 / 累计结算 / 累计付款）自 2026-10-15 起
 * 全部在 `domain/contract-chain.ts`——因为"上限"必须与"合同当前金额"是同一个口径。
 * .mts spec 可加载带 .ts 后缀的相对 import（testing.md 第 1 条已于 2026-10-17 解除限制），
 * 舍入统一走共享原语，不再本地复制。
 */
import { round2 } from '../common/calc/money.ts';

/** 超限策略：BLOCK 拦截 / WARN 仅提示 / OFF 不校验 */
export type OverAmountPolicy = 'BLOCK' | 'WARN' | 'OFF';

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
// @metric: overdue-over-amount
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
