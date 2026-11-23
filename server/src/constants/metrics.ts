/**
 * **报表口径登记表（单一事实源）** —— 每个对外可见的金额/数量指标，只能有一处实现。
 *
 * 为什么要有它（2026-11-23 架构评审）：系统的真痛点不是"模块之间互相 import"（那层已由
 * `check-module-boundaries` 锁死），而是**同一个指标在不同页面各算一遍**——
 * 合同额在看板是裸 `SUM(amount)`、在台账是"链根只计一次"，有补充协议时两个数字不相等，
 * 而且没有人能列出"这个系统到底有哪些指标、分别谁说了算"。
 *
 * 机制（两道锁，见 `server/test/metricsRegistry.spec.mts`）：
 * 1. **实现侧**：每个指标的唯一实现函数上方必须写 `// @metric: <id>`，全仓该 id 恰好出现一次；
 * 2. **登记侧**：本文件登记 id / 拥有者（owner 模块，"改这个口径该谁签字"）/ 唯一实现位置，
 *    且 `docs/report-metrics.md` 必须逐行列出——三处（代码标记、本表、文档）不许漂移。
 *
 * 新增指标的流程：
 * 1. 先在 owner 模块（或 `common/utils` 纯函数）里把口径收敛成**一处**实现；
 * 2. 在该函数上方加 `// @metric: <id>`；
 * 3. 在 `METRICS` 里登记（impl 必须与标记所在文件一致）；
 * 4. 在 `docs/report-metrics.md` 表格里加一行；
 * 5. `npm test` 会逐条校验，缺一处就红。
 *
 * ⚠️ 登记的前提是**它真的只有一处**。已知还有偏差的指标不要登记（会把不一致固化），
 * 先在 `docs/report-metrics.md` §「已知偏差」里记着，收敛完再登记。
 */

export interface MetricDef {
  /** 指标 id，与代码里的 `// @metric: <id>` 一一对应（全局唯一） */
  id: string;
  /** 中文名（人看的名，可改；id 不要改） */
  name: string;
  /** 拥有该口径的模块目录名（改口径时由它签字）；横切口径写 `common` / `constants` */
  owner: string;
  /** 唯一实现：仓库相对路径 + 符号名（路径必须与 `@metric` 标记所在文件一致） */
  impl: string;
  /** 一句话口径（含关键排除项，如"排除草稿结算""排除失败/退款付款"） */
  note: string;
}

/** 已收敛为**单一实现**的报表口径。按 id 字母序便于 review。 */
export const METRICS: readonly MetricDef[] = [
  {
    id: 'asset-flow',
    name: '物资进出场汇总',
    owner: 'asset',
    impl: 'server/src/common/utils/asset-flow.ts#summarizeAssetFlow',
    note: '采购/调入 = 进场，调出/处置 = 出场；调入费/维保费只计金额、不计进出场数量；未知来源单列不混入',
  },
  {
    id: 'contract-chain-amount',
    name: '合同链金额',
    owner: 'contract',
    impl: 'server/src/common/utils/contract-chain.ts#resolveChainAmounts',
    note: '链根只计一次：主合同 amount + Σ 补充协议 changeAmount（补充协议的自由 amount 不参与）',
  },
  {
    id: 'contract-material-qty',
    name: '合同清单量与已结量',
    owner: 'contract',
    impl: 'server/src/common/utils/contract-chain.ts#chainMaterialQty',
    note: '清单量按合同链归集；已结量只算非草稿结算的明细（量级闸门的输入）',
  },
  {
    id: 'contract-paid-total',
    name: '累计付款（合同链）',
    owner: 'payment',
    impl: 'server/src/common/utils/contract-chain.ts#chainPaidTotal',
    note: '按链归集；排除 FAILED/REFUNDED（`PAYMENT_EXCLUDED_STATUSES`），空状态按有效付款计入',
  },
  {
    id: 'contract-settled-total',
    name: '累计结算（合同链）',
    owner: 'settlement',
    impl: 'server/src/common/utils/contract-chain.ts#chainSettledTotal',
    note: '按链归集；**排除草稿结算**（DRAFT），含补充协议下挂的结算',
  },
  {
    id: 'ledger-chain-root-amount',
    name: '台账「合同额」',
    owner: 'ledger',
    impl: 'server/src/common/utils/ledger-derived.ts#chainRootAmounts',
    note: '按链根只计一次（与本表 contract-chain-amount 同口径，供台账逐行分摊）',
  },
  {
    id: 'ledger-derived-amounts',
    name: '台账派生金额',
    owner: 'ledger',
    impl: 'server/src/common/utils/ledger-derived.ts#deriveLedgerAmounts',
    note: '已付/未付/付款比例/开累等派生列；税率未填时税前与进项税留 null（未知不兜 0%）',
  },
  {
    id: 'ledger-invoice-tax',
    name: '台账发票税额拆分',
    owner: 'ledger',
    impl: 'server/src/common/utils/ledger-derived.ts#sumInvoiceTax',
    note: '按发票税率分档汇总；隐含税率（含税/不含税）与显式税率分列，不互相覆盖',
  },
  {
    id: 'overdue-over-amount',
    name: '金额上限闸门（超结/超付）',
    owner: 'finance',
    impl: 'server/src/common/utils/amount-guard.ts#checkOverAmount',
    note: '严格大于才判超限；策略 BLOCK 拦、WARN 只提示、OFF 不校验；草稿与失败/退款付款豁免',
  },
  {
    id: 'overdue-summary',
    name: '逾期应付汇总与利息',
    owner: 'finance',
    impl: 'server/src/common/utils/overdue-summary.ts#summarizeOverdue',
    note: '利息按日计并按合同上限比例封顶；汇总口径与逐行 `interestOf` 同一份实现',
  },
  {
    id: 'payment-counted-statuses',
    name: '计入累计付款的付款状态集',
    owner: 'payment',
    impl: 'server/src/constants/statuses.ts#paidPaymentWhere',
    note: '排除 FAILED/REFUNDED；`statusCode IS NULL` 归入有效（历史导入数据），防 SQL 三值逻辑静默漏算',
  },
  {
    id: 'settlement-period-key',
    name: '结算期归属',
    owner: 'settlement',
    impl: 'server/src/common/utils/settlement-period.ts#periodKeyOf',
    note: '按项目「结算起始日」切期（起始日 26 时 9/28 的日报归 10 月期），不是自然月',
  },
];

/** 便于测试与调用方遍历 */
export const METRIC_IDS: readonly string[] = METRICS.map((m) => m.id);
