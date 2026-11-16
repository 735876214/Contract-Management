/**
 * dict 模块对外公开入口。
 *
 * 其他模块只允许 `from '../dict'`；直接引 `dict/dict.service` 会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { DictModule } from './dict.module';
export { DictService } from './dict.service';
