/**
 * 金额舍入与中文大写 —— 全站唯一实现（前后端共用，零依赖）。
 *
 * 原位置 `server/src/common/utils/money.ts` 现在只做兼容再导出；前端 `web/src/utils/money.ts`
 * 只做**展示**格式化（千分位/空值占位），舍入与中文大写仍以本文件为唯一实现。
 * 改动本文件必须同步跑 `server/test/money.spec.ts`、`test/moneyFormat.spec.mts` 与
 * `server/test/frontendChainParity.spec.mts`，禁止再在各模块复制舍入公式。
 */
export declare function amountToChineseCapital(input: number | string | null | undefined): string;
/**
 * 金额四舍五入（模拟 Excel ROUND，避免浮点误差）。
 * null / undefined / 非有限值统一返回 null，调用方可用 ?? 0 兜底。
 *
 * 字符串位移法（`n.toString()` 已是能还原该 double 的最短十进制，位移后取整即人眼口径），
 * 并按符号取整，保证 `round(-x) === -round(x)`，与 Excel ROUND 的「半值远离零」一致。
 * 禁止改回 `Math.round((n + Number.EPSILON) * p) / p`：
 * 8.165 → 8.16、1234567.005 丢 1 分、-1.005 → -1。
 */
export declare function round(n: number | null | undefined, digits?: number): number | null;
export declare const round2: (n: number | null | undefined) => number;
export declare const round4: (n: number | null | undefined) => number;
