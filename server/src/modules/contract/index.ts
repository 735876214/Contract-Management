/**
 * contract 模块对外公开入口。
 *
 * 其他模块只允许 `from '../contract'`；直接引 `contract/contract.module` / `contract/contract.service`
 * 会被 `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { ContractModule } from './contract.module';
export { ContractService } from './contract.service';
// 合同主表写入原语：需要改合同行的模块（总结算/财务/采购）走这里，不直接写表
export {
  setContractExecStatus,
  updateContractFundingParams,
  deleteContractsOfTask,
  deleteContractsByIds,
} from './contract-writes';
// 付款安排与「当前生效比例」口径（finance 复用；改口径由本模块签字）
export { PAYMENT_MODES, modeTranchesOf, paymentModeViolation } from './pay-ratio';