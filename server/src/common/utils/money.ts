/**
 * 兼容入口：金额口径的唯一实现已下沉到 `common/calc/money.ts`（前后端共用）。
 *
 * 老代码继续从 `@/common/utils/money` 导入即可；新代码建议直接从
 * `@/common/calc`（后端）或共享入口（前端）导入，禁止再复制舍入公式。
 */
export { amountToChineseCapital, round, round2, round4 } from '../calc/money.ts';
