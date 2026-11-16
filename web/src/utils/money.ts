/**
 * 金额口径唯一实现的兼容入口。
 *
 * 实现已下沉到 `server/src/common/calc/money.ts`，前后端共用同一份源码。
 * 禁止在本文件重新实现 round / 大写金额（历史上这里用的是已废弃的 EPSILON 旧公式，
 * 8.165 → 8.16、1234567.005 丢 1 分，且与服务端落库值不一致）。
 */
export {
  amountToChineseCapital,
  round,
  round2,
  round4,
} from '../../../server/src/common/calc/money.ts';
