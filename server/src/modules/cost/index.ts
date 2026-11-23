/**
 * cost 模块对外公开入口。
 *
 * 其他模块只允许 `from '../cost'`；直接引内部 service 文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { CostModule } from './cost.module';
export { LaborReceivingService } from './labor-receiving.service';
export { MonthlyProfitLossService } from './monthly-profit-loss.service';
// 劳务收领单口径（receipt-order 复用：可收量 where、行键、平均/加权单价）
export { laborReceivingReceiptWhere, laborRowKey } from './labor-receiving';
