# 报表口径登记表（单一事实源）

> **这是什么**：全系统对外可见的金额/数量指标，每个指标的**唯一实现**在哪、归谁签字、谁在消费。
> 由 `server/src/constants/metrics.ts` 承载，由 `server/test/metricsRegistry.spec.mts` 锁定
> （代码标记 ↔ 本表 ↔ 文档，三处漂移即红）。
>
> **为什么要有**（2026-11-23 架构评审）：真痛点不是模块互相 import（那层已由
> `check-module-boundaries` 锁死），而是**同一个指标在不同页面各算一遍**。典型例子见 §2。

## 1. 已收敛的口径（登记在案）

> 判断标准：**同一指标只有一处实现**，且消费方都 import 它，不自己写 where。

| 指标 id | 指标 | owner | 唯一实现 | 消费方 | 口径要点 |
|---|---|---|---|---|---|
| `asset-flow` | 物资进出场汇总 | asset | `common/utils/asset-flow.ts#summarizeAssetFlow` | asset, ai | 采购/调入=进场，调出/处置=出场；调入费/维保费只计金额不计数量；未知来源单列不混入 |
| `contract-chain-amount` | 合同链金额 | contract | `common/utils/contract-chain.ts#resolveChainAmounts` | contract, dashboard, ledger, ai | 链根只计一次：主合同 `amount` + Σ 补充协议 `changeAmount`（补充协议的自由 `amount` 不参与） |
| `contract-material-qty` | 合同清单量与已结量 | contract | `common/utils/contract-chain.ts#chainMaterialQty` | settlement, ai | 清单量按合同链归集；已结量只算非草稿结算明细（量级闸门输入） |
| `contract-paid-total` | 累计付款（合同链） | payment | `common/utils/contract-chain.ts#chainPaidTotal` | payment, payment-procedure | 按链归集；排除 `FAILED`/`REFUNDED`，空状态按有效付款计入 |
| `contract-settled-total` | 累计结算（合同链） | settlement | `common/utils/contract-chain.ts#chainSettledTotal` | contract, dashboard, payment, payment-procedure, settlement, ai | 按链归集；**排除草稿结算**，含补充协议下挂的结算 |
| `ledger-chain-root-amount` | 台账「合同额」 | ledger | `common/utils/ledger-derived.ts#chainRootAmounts` | ledger | 按链根只计一次，供台账逐行分摊（与 `contract-chain-amount` 同口径） |
| `ledger-derived-amounts` | 台账派生金额 | ledger | `common/utils/ledger-derived.ts#deriveLedgerAmounts` | ledger | 已付/未付/付款比例/开累等派生列；税率未填时税前与进项税留 `null`（未知不兜 0%） |
| `ledger-invoice-tax` | 台账发票税额拆分 | ledger | `common/utils/ledger-derived.ts#sumInvoiceTax` | ledger | 按税率分档汇总；隐含税率（含税/不含税）与显式税率分列，不互相覆盖 |
| `overdue-over-amount` | 金额上限闸门（超结/超付） | finance | `common/utils/amount-guard.ts#checkOverAmount` | payment, settlement | 严格大于才判超限；策略 `BLOCK` 拦 / `WARN` 提示 / `OFF` 不校验；草稿与失败/退款付款豁免 |
| `overdue-summary` | 逾期应付汇总与利息 | finance | `common/utils/overdue-summary.ts#summarizeOverdue` | finance, settlement | 利息按日计并按合同上限比例封顶；汇总与逐行 `interestOf` 同一份实现 |
| `payment-counted-statuses` | 计入累计付款的付款状态集 | payment | `constants/statuses.ts#paidPaymentWhere` | contract, dashboard, ledger, payment, payment-procedure, ai | 排除 `FAILED`/`REFUNDED`；`statusCode IS NULL` 归入有效（历史导入数据），防 SQL 三值逻辑静默漏算 |
| `settlement-period-key` | 结算期归属 | settlement | `common/utils/settlement-period.ts#periodKeyOf` | settlement, invoice, cost, final-settlement, contract, archive, ai | 按项目「结算起始日」切期（起始日 26 时 9/28 的日报归 10 月期），**不是自然月** |

## 2. 已知偏差（**未收敛**，不要登记成单一实现）

> 这些地方同一个指标有两个算法，数字会对不上。收敛属于业务口径决策，
> 逐项确认后再登记；在那之前先留在这里，让评审时看得见。

### 2.1 合同额：看板裸加 `amount`，台账按链根计一次

| 位置 | 算法 | 后果 |
|---|---|---|
| `server/src/modules/dashboard/dashboard.service.ts:32-36`（`overview` 的 `contractAmount`） | `contract.aggregate({ _sum: { amount: true } })` — **裸加** | 有补充协议时，看板「合同额」**小于**台账「合同额」（少掉 Σ`changeAmount`） |
| `server/src/modules/dashboard/dashboard.service.ts:109`（`contractType`） | `groupBy(typeCode).aggregate(_sum.amount)` — 同样裸加 | 按类型分布合计 ≠ 台账合同额 |
| `server/src/common/utils/ledger-derived.ts#chainRootAmounts` / `contract-chain.ts#resolveChainAmounts` | 链根只计一次（主合同 + Σ 补充协议 `changeAmount`） | 这是正确口径（已登记 `contract-chain-amount`） |

**修法**：看板改为按链根聚合（或直接复用 `resolveChainAmounts`），两处同时改，**看板数字会变大**（补充协议增量），属于口径修正而非回归。

### 2.2 合同已结算/已付款：看板已有两处对齐，但合同详情仍自算

- `dashboard.service.ts:46-54` 的「累计付款」「累计开票」已分别走 `paidPaymentWhere()` 与 `countedInvoiceWhere()`，与台账同口径 ✅；
- 但 `contract.service.ts` 详情里的 `receiptOrder.count` / `invoice.count` / `settlement.count`（约 1111-1115 行）是**按链 id 列表各数一次**，与 `chainSettledTotal` 的"金额"口径不同源（一个是计数、一个是金额），
  若将来要"合同卡片金额"与台账对齐，应改为调用已登记的 `contract-settled-total` / `contract-paid-total`。

## 3. 维护方式

新增或修改口径时：

1. **先收敛**：把口径收进 owner 模块的纯函数（或 `common/utils`），让消费方 import 它；
2. **加标记**：在该函数上方写 `// @metric: <id>`（全仓只允许一处）；
3. **登记**：`server/src/constants/metrics.ts` 的 `METRICS` 加一条（`impl` 必须与标记文件一致）；
4. **写文档**：本文件 §1 表格加一行（`| \`<id>\` | ...`，spec 逐行校验）；
5. `cd server && npm test` —— `metricsRegistry.spec.mts` 会逐条校验，缺一处就红。

> ⚠️ 登记的前提是**它真的只有一处**。已知还有分叉的指标先写在 §2，**收敛完再登记**——
> 否则等于把不一致固化进"单一事实源"。
