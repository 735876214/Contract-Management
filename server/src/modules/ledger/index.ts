/**
 * ledger 模块对外公开入口。
 *
 * 其他模块只允许 `from '../ledger'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { LedgerModule } from './ledger.module';
export { LedgerService } from './ledger.service';
// 台账派生金额口径（工作台/发票复用；改口径由本模块签字）
export { chainContractTotal, isFilledNumber } from './ledger-derived';
