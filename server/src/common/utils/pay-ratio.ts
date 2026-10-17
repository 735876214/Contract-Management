/**
 * **付款安排（`Contract.paymentMode`）与「当前生效付款比例」**的单一事实源（纯函数、零依赖）。
 *
 * 业务口径（2026-10-16 澄清）：
 * - 月度结算办理的付款安排**二选一**：
 *   - `M65_1`：当月办理结算后，**次月 30 日前付 65%**；
 *   - `M65_3`：当月办理结算后，**次月 20% + 次次月 20% + 次次次月 25%**（合计仍是 65%）。
 * - 总结算办理完成后走**总结算节点**，比例固定 **100%**。
 * - 存量的 `100`（次月 25 日前 100%）与 `3382`（第 3 月 80% + 第 6 月 20%）**保留不动**：
 *   它们是既有合同的付款条件，改了会连带改动已算出的逾期利息。
 *
 * **「当前生效比例」（`ContractExt.currentPayRatio`）是派生列**，由
 * `resolveEffectivePayRatio()` 一处判定，落库动作在 `contract.service.syncPayRatio()`：
 * ① 已完已结（`execStatus = DONE_SETTLED`）→ **1.0**（总结算节点）；
 * ② 否则 → 该付款安排**各期比例之和**（`100`→1、`3382`→1、`M65_1`/`M65_3`→0.65）；
 * ③ `CUSTOM`（自定义安排）或模式未填 → 用合同上手填的 `settlementPayRatio`；
 * ④ 都推不出来 → 返回 `null`，**调用方保持原值不动**（"未知"不该被改写成某个数）。
 *
 * ⚠️ 台账「当前合同付款比例」列、逾期利息引擎的 `paymentRatio`、P5 的付款预警**都读这一个派生值**，
 * 所以规则只在这里写一次——别在 service 里就地拼。
 * 保持纯函数（零第三方依赖）；相对 import 须带 `.ts` 后缀（2026-10-17 解除零依赖限制，见 .claude/rules/testing.md）。
 */

/** 一期付款：比例 + 结算月偏移 + 应付款日 */
export interface PayTranche {
  ratio: number;
  plusMonths: number;
  day: number;
}

export interface PaymentModeDef {
  /** 给人看的说明（前端下拉与提示文案共用） */
  label: string;
  /** 各期付款；合计 = 该安排的**月度比例** */
  tranches: PayTranche[];
}

/**
 * 付款安排定义表。
 * 命名：`M`=月度节点、数字=月度比例、下划线后=**分几期**（`M65_3` 即 65% 分 3 期）。
 */
export const PAYMENT_MODES: Record<string, PaymentModeDef> = {
  '100': {
    label: '次月 25 日前支付 100%',
    tranches: [{ ratio: 1, plusMonths: 1, day: 25 }],
  },
  '3382': {
    label: '第 3 个月内支付 80%，第 6 个月支付剩余（合计 100%）',
    tranches: [
      { ratio: 0.8, plusMonths: 3, day: 25 },
      { ratio: 0.2, plusMonths: 6, day: 25 },
    ],
  },
  M65_1: {
    label: '月度结算：次月 30 日前支付 65%',
    tranches: [{ ratio: 0.65, plusMonths: 1, day: 30 }],
  },
  M65_3: {
    label: '月度结算：次月 20% + 次次月 20% + 次次次月 25%（合计 65%）',
    tranches: [
      { ratio: 0.2, plusMonths: 1, day: 30 },
      { ratio: 0.2, plusMonths: 2, day: 30 },
      { ratio: 0.25, plusMonths: 3, day: 30 },
    ],
  },
};

/** 自定义安排：应付节点由人手工录入（`CUSTOM` 不给出 tranches） */
export const CUSTOM_PAYMENT_MODE = 'CUSTOM';

/** 某付款安排的分期（未定义 / 自定义 → `null`；`CUSTOM` 走手工录入，故也没有默认分期） */
export function modeTranchesOf(mode: string | null | undefined): PayTranche[] | null {
  if (!mode) return null;
  return PAYMENT_MODES[mode]?.tranches ?? null;
}

/**
 * 某付款安排的**月度比例** = 各期比例之和（`100`/`3382` → 1；`M65_1`/`M65_3` → 0.65）。
 * 自定义或未知安排 → `null`（**不是 0**：0 会被下游当成"一分钱都不用付"）。
 */
export function monthlyRatioOfMode(mode: string | null | undefined): number | null {
  const tranches = modeTranchesOf(mode);
  if (!tranches?.length) return null;
  const sum = tranches.reduce((s, t) => s + (Number(t.ratio) || 0), 0);
  // 浮点求和（0.2+0.2+0.25）保留两位小数语义：比例是两位以内的业务数，四舍五入到 4 位足够
  return Math.round(sum * 1e4) / 1e4;
}

export interface EffectivePayRatioInput {
  /** 合同执行情况（`Contract.execStatus`）；`DONE_SETTLED` = 已完已结 = 总结算已办理 */
  execStatus?: string | null;
  /** 付款安排（`Contract.paymentMode`） */
  paymentMode?: string | null;
  /** 合同上手填的月度比例（自定义安排时使用） */
  customRatio?: number | string | null;
}

/** 已完已结（总结算办理完成）的执行状态码；与字典 `contract_execution_status` 一致 */
export const EXEC_STATUS_DONE_SETTLED = 'DONE_SETTLED';

/**
 * 判定**当前生效比例**。返回 `null` 表示"推不出来"——调用方**保持原值不动**（见文件头 ④）。
 */
export function resolveEffectivePayRatio(input: EffectivePayRatioInput): number | null {
  if (input.execStatus === EXEC_STATUS_DONE_SETTLED) return 1;
  const byMode = monthlyRatioOfMode(input.paymentMode);
  if (byMode !== null) return byMode;
  const custom = Number(input.customRatio);
  // 手填 0 是"真实填了 0"吗？—— 这里按"未填"处理：比例 0 意味着永不付款，
  // 只可能是没填或填错；要让下游据此预警得先有人真的填 0 且业务确认，故宁可返回 null 不覆盖。
  return Number.isFinite(custom) && custom > 0 ? custom : null;
}
