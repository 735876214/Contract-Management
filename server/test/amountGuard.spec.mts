import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkOverAmount, normalizePolicy } from '../src/common/utils/amount-guard.ts';

/**
 * 防超结 / 防超付 的**上限判定**部分（口径见 .claude/rules/backend-conventions.md「金额上限」）：
 * 策略归一 + 「已占用 + 本次」与上限的比较。
 *
 * 链口径（合同当前金额 / 累计结算 / 累计付款）与那部分 mock 用例自 2026-10-15 起
 * 在 `contractChain.spec.mts`——实现搬到了 `common/utils/contract-chain.ts`，
 * 因为"上限"必须与"合同当前金额"共用同一份实现（本文件被 spec 加载，不能新增相对 import）。
 */
