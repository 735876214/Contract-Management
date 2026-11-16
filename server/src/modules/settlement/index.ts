/**
 * settlement 模块对外公开入口。
 *
 * 其他模块只允许 `from '../settlement'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { SettlementModule } from './settlement.module';
export { SettlementService } from './settlement.service';
