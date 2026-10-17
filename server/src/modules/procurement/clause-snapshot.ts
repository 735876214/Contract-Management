/**
 * 「条款选择」的**纯逻辑**（业务口径 2026-10-16）：条款只在「基础信息管理 → 合同条款」维护，
 * 采购发起第三步 / 合同起草只做"选择"，不再就地富文本录入。
 *
 * 为什么单独抽零依赖文件：本模块要被 `server/test/clauseSelection.spec.mts`（Node 原生类型擦除）
 * 直接加载 —— `.mts` 硬约束要求**零相对 import**（见 `.claude/rules/testing.md`）。
 * service 侧（procurement-task.service）负责"查库 + 抛 400"，本文件只负责"无副作用的映射与拼接"，
 * 两层的分界让单测能锁住规则本身而不是绕着 Prisma 打转。
 */

/** 条款类型（与「合同条款」页 `Clause.type` 的四种取值一致） */
export type ClauseType = 'technical' | 'quality' | 'payment' | 'acceptance';

/** 四种条款类型的中文名（与前端 `CLAUSE_TYPE_OPTIONS` 的 label 一致；单测锁两侧一致） */
export const CLAUSE_TYPE_LABELS: Record<ClauseType, string> = {
  technical: '技术条款',
  quality: '质量条款',
  payment: '付款条件',
  acceptance: '验收方式',
};

/** 条款选择槽位 → 要求的条款类型（一一对应；写错类型会让模板变量拿到奇怪内容） */
export const SLOT_TYPE_OF: Record<string, ClauseType> = {
  technicalClauseId: 'technical',
  qualityClauseId: 'quality',
  paymentClauseId: 'payment',
  acceptanceClauseId: 'acceptance',
};

/** 采购任务三个文本列的快照输出 */
export interface ClauseSnapshot {
  techQuality?: string | null;
  acceptanceMethod?: string | null;
  paymentMethod?: string | null;
}

/**
 * 校验一批"槽位 → 条款"的选择并产出快照。
 *
 * @param input 各槽位的条款 id；`null/''` = 显式清除该槽位（对应文本列一并清空——
 *              否则界面看着没选、模板变量却还有值）；`undefined` = 本轮未提及，不动。
 * @param lookup id → 条款（`{ type, content }`）；查不到（= 条款已被删）由调用方抛 400。
 * @param onMissing 查不到条款时的错误工厂（service 传 `BadRequestException` 工厂，单测传 throw）。
 *
 * 拼接规则：`techQuality` = 技术条款正文 +（选了质量条款时）质量条款正文，用换行分隔；
 * `acceptanceMethod` / `paymentMethod` 各取自己的条款正文。
 */
export function resolveClauseSnapshot(
  input: Partial<Record<string, string | null | undefined>>,
  lookup: (id: string) => { type?: string | null; content?: string | null } | undefined,
  onMissing: (id: string) => Error,
  onTypeMismatch: (slot: string, expected: ClauseType, actual: string | null) => Error,
): ClauseSnapshot {
  const out: ClauseSnapshot = {};

  const contentOf = (slot: string): string | null => {
    const v = input[slot];
    if (v === undefined) return undefined as unknown as null; // 未提及 → 调用方判 undefined
    if (v === null || v === '') return null; // 显式清除 → 快照清空
    const clause = lookup(String(v));
    if (!clause) throw onMissing(String(v));
    const expected = SLOT_TYPE_OF[slot];
    if (expected && clause.type !== expected) throw onTypeMismatch(slot, expected, clause.type ?? null);
    return clause.content ?? '';
  };

  const tech = contentOf('technicalClauseId');
  const quality = contentOf('qualityClauseId');
  const acceptance = contentOf('acceptanceClauseId');
  const payment = contentOf('paymentClauseId');

  // 技术与质量任一被提及都要重算 techQuality（两段用换行分隔；全空 → null）
  if (input.technicalClauseId !== undefined || input.qualityClauseId !== undefined) {
    const merged = [tech, quality].filter((s) => s != null && s !== '').join('\n');
    out.techQuality = merged === '' ? null : merged;
  }
  if (input.acceptanceClauseId !== undefined) out.acceptanceMethod = acceptance;
  if (input.paymentClauseId !== undefined) out.paymentMethod = payment;
  return out;
}
