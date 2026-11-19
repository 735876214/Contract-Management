/**
 * receipt-order 模块对外公开入口。
 *
 * 其他模块只允许 `from '../receipt-order'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */

export { ReceiptOrderModule } from './receipt-order.module';
export { ReceiptOrderService } from './receipt-order.service';
/** 结算单挂接关系的写入原语（给 settlement 模块按结算期挂/解挂收领单用，需传入事务句柄） */
export {
  attachReceiptOrdersToSettlement,
  detachReceiptOrders,
  detachReceiptOrdersOfSettlement,
} from './receipt-order-settlement-link';