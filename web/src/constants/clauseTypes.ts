/**
 * 「合同条款」的类型常量（**零 import**，供 `server/test/clauseSelection.spec.mts` 直接加载）。
 *
 * 为什么抽出来：条款类型原本定义在 `pages/Clauses.tsx` 里，而 `.tsx`（JSX）**永远**进不了
 * `.mts` 单测（Node 类型擦除不支持 JSX，见 `.claude/rules/testing.md`）；
 * 后端条款快照逻辑要锁"四个槽位 ↔ 四种条款类型一一对应"，就必须能加载这份常量。
 * `Clauses.tsx` 与 `Contracts.tsx` 从这里 re-export，行为不变。
 */

/** 条款类型（与后端 `Clause.type` 一致）：technical 技术条款 / quality 质量条款 / payment 付款条件 / acceptance 验收方式 */
export type ClauseType = 'technical' | 'quality' | 'payment' | 'acceptance';

/** 类型下拉选项（`Clauses.tsx` 的新增/编辑弹窗与筛选用；`Contracts.tsx` 的四个条款下拉用） */
export const CLAUSE_TYPE_OPTIONS: { value: ClauseType; label: string }[] = [
  { value: 'technical', label: '技术条款' },
  { value: 'quality', label: '质量条款' },
  { value: 'payment', label: '付款条件' },
  { value: 'acceptance', label: '验收方式' },
];

/** 类型编码 → 名称 */
export const CLAUSE_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  CLAUSE_TYPE_OPTIONS.map((t) => [t.value, t.label]),
);
