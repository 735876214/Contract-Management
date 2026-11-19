/**
 * invoice 模块对外公开入口。
 *
 * 其他模块只允许 `from '../invoice'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { InvoiceModule } from './invoice.module';
export { InvoiceService } from './invoice.service';
/** 结算单挂接关系的写入原语（给 settlement 模块按结算期挂/解挂发票用，需传入事务句柄） */
export {
  attachInvoicesToSettlement,
  detachInvoices,
  detachInvoicesOfSettlement,
} from './invoice-settlement-link';
