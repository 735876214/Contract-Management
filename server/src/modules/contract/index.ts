/**
 * contract 模块对外公开入口。
 *
 * 其他模块只允许 `from '../contract'`；直接引 `contract/contract.module` / `contract/contract.service`
 * 会被 `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { ContractModule } from './contract.module';
export { ContractService } from './contract.service';
