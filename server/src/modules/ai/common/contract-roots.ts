/**
 * AI · **合同链根解析**（对外入口）。
 *
 * 实现已收口到 `domain/contract-chain.ts`：链根上溯、深度上限、断链判定
 * 与「合同当前金额」共用同一份代码，避免 AI 与业务侧各维护一套 8 层循环。
 * 这里只保留 AI 侧稳定的 import 路径。
 */

export {
  CHAIN_MAX_DEPTH as CHAIN_DEPTH_LIMIT,
  chainRowCountByRoot,
  indexContractRows,
  resolveChainRoot,
  type ChainRootResult,
  type ContractChainRowLike,
} from '../../../domain/contract-chain.ts';
