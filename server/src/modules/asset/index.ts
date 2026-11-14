/**
 * asset 模块对外公开入口。
 *
 * 其他模块只允许 `from '../asset'`；直接引 `asset/asset.module` / `asset/asset.service` 会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { AssetModule } from './asset.module';
export { AssetService } from './asset.service';
