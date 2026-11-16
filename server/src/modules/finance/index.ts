/**
 * finance 模块对外公开入口。
 *
 * 其他模块只允许 `from '../finance'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { FinanceModule } from './finance.module';
export { FinanceService } from './finance.service';
