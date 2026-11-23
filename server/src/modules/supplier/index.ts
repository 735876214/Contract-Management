/**
 * supplier 模块对外公开入口。
 *
 * 其他模块只允许 `from '../supplier'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { SupplierModule } from './supplier.module';
export { SupplierService } from './supplier.service';
// 供应商签订快照（合同/模板复用；「改名换行不该改写历史合同」那条口径的唯一实现）
export { mergeSupplierFields, parseSupplierSnapshot, pickSupplierSnapshot } from './supplier-snapshot';
