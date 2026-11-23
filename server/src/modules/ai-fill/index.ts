/**
 * ai-fill 模块对外公开入口（单据登记与取价/履约判定（写路径复用业务模块校验））。
 *
 * 其他模块只允许 `from '../ai-fill/index.ts'`；直接引内部文件会被 `scripts/check-module-boundaries.mjs` 判为越界。
 * 下面只导出**别的模块真正需要的符号**（按调用方实际 import 生成，不是 export *）。
 */

export { FulfillmentService } from './fulfillment/fulfillment.service.ts';
export type { FulfillmentAnomalyQuery } from './fulfillment/fulfillment.service.ts';
export { QuoteService } from './quote/quote.service.ts';
export type { QuoteAnomalyQuery } from './quote/quote.service.ts';
export { RegisterService } from './register.service.ts';
export type { RegisterConfirmInput } from './register.service.ts';
