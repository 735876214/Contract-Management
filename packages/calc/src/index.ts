/**
 * 统一计算引擎的**聚合入口**：`import { round2, monthKey } from '@cms/calc'`。
 * 也可以按文件取（`@cms/calc/money`），意图更清楚。
 *
 * 纪律：任何一侧（server / web）都不得再复制计算、舍入、税率、日期格式公式——
 * 前后端口径漂移由 `server/test/*Parity.spec.mts` 锁住。
 */
export * from './money';
export * from './numeric';
export * from './rate';
export * from './amounts';
export * from './procurement';
export * from './aggregate';
export * from './time';
export * from './format';
