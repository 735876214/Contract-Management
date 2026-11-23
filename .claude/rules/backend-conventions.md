# 后端约定细则（改动前必看）

> **何时加载**：改动 `server/src/**`、`server/prisma/**`，或涉及迁移、service、controller、台账/结算/日志时。
> 规则本体在 [CLAUDE.md](../../CLAUDE.md)；本文件是它的展开。

## 迁移与外键

- **新增采购阶段子模块需同步改六处**（漏一处必现"页面有、取值空"）：`schema.prisma`（含**两侧反引用**）→
  迁移 SQL → service（`xxx()/saveXxx()/serializeXxx()/publish()` 校验）→ controller（GET+PUT）→
  前端 `api/modules.ts` + `constants/procurementVariables.ts` → `utils/<模块>.ts` + 页面。
- **加外键必须在同一迁移内先做数据清洗**（空串归一为 NULL、悬空引用置 NULL；不可空列则以
  `RAISE EXCEPTION` 拦截而非静默删行），否则线上库 `ADD CONSTRAINT` 直接失败；
  新增 `xxxId` 字段须建 `@relation` 或登记进 `schemaDanglingRefs.spec.mts` 的白名单。
  范例：`prisma/migrations/20261014000000_p1_consistency/migration.sql`。
- 迁移生成姿势（本机非交互 shell）见 [docs/development.md §9](../../docs/development.md)。

## service 层通用

- **乐观锁**：业务表多有 `version Int`。两步走，**缺一不可**（2026-11-23 第 24 轮审计）：
  ① `helpers.assertVersion(old, data)` —— 客户端没回传/版本不一致直接 409（友好、早失败）；
  ② 落库必须用 `helpers.versionedUpdate(this.prisma.xxx, id, old.version, payload)` ——
  把版本条件放进 `where`、在同一次写入里 `version + 1`，命中不了行转 409。
  ⚠️ 只做 ① 而写 `update({ where: { id } })` 是**假的乐观锁**：校验与写入之间有并发窗口，
  两人同刻保存会双双通过、后写静默覆盖前写。⚠️ 更隐蔽的一种：`pickFields` 白名单里没有 `version`
  时版本号永远写不回去（资产台账曾如此），锁当场失效。
- **写字段白名单**：service 用 `common/pick-fields.ts` 的 `pickFields` 过滤未知字段，防前端字段漂移 500。
- **按 id 取记录必须过归属校验**：`helpers.assertInProject(row, projectId, 'X不存在')`。
  守卫只保证"你是这个项目的成员"，不保证"这条记录属于这个项目"；少了这一步，
  同时属于两个项目的用户拿别项目的 id 配自己项目的 header 就能读/改/删（守卫语义见
  [architecture.md §5](../../docs/architecture.md)）。返回 `404` 而不是 `403`，避免暴露记录存在性。
- **列表日期区间统一走 `common/calc/time` 的本地日原语**：`gte: startOfDay(startDate)` /
  `lte: endOfDay(endDate)`（或 `lt: nextDayStart(endDate)`），**禁止** `new Date(query.endDate)`
  ——`'YYYY-MM-DD'` 交给 `new Date` 是**按 UTC 解析**（本地 08:00），库里存本地 00:00 的记录会被漏掉；
  手拼 `'T23:59:59'` / 就地 `setHours` 也不许再新增。原语拒绝 `2026-02-30` 这类"格式对但不存在"的日期，
  非法值返回 `null`（调用方跳过该条件，别把 `null` 写进 `where`）。锁定：`test/timeBounds.spec.mts`。
- **需要"全部数据"时用 `common/utils/paged.ts` 的 `pagedAll()`**：不要写 `findAll({ pageSize: 5000 })`——
  `paginate()` 会把单页夹到上限，超出部分静默丢失（2026-10 审计在 8 个模块各踩过一次）。
  调用方要同时把 `pageSize` 传给 `maxPageSize`：`findAll({ page, pageSize }, projectId, pageSize)`。
- **跨域只读查询走 `server/src/query/`**：`archive` 等聚合器**不得**在 service 里散写
  `prisma.<任意模型>`，统一走 `query/<域>-queries.ts`（只读、无事务、显式带 `projectId`）；
  由 `scripts/check-module-boundaries.mjs` 锁定。AI 的只读子域同样不得依赖业务模块，
  `ai/register.service.ts` 的写路径是刻意例外。见 [module-boundaries.md](module-boundaries.md)。
- **日志必须脱敏（白名单）**：操作日志拦截器把「请求参数 + 变更前后快照」整体写入 `OperationLog`
  （日志页仅需 `system:user` 权限即可查看），**凭据/银行账号/证件号/联系方式不得明文入库**。
  规则集中在 `common/utils/mask.ts`（`slimSecrets()` 深拷贝后按键名打码，**不改原对象**——入参可能是
  即将返回给前端的响应体）；新增敏感字段须登记进 `SECRET_FIELD_KEYS`，契约由 `mask.spec.mts` 锁定。
- **文件落盘只有一条路**：`common/services/storage.service.ts`（`StorageService`，上传/签章件/导入错误报告
  三个写入点都走它）——**不要在 service/controller 里自己拼 `UPLOAD_DIR` 与文件名**；键是**相对 POSIX 路径**
  （`signed/x.pdf`，用 `/` 不用 `path.join`，否则 Windows 下落库成 `signed\x.pdf`），对外 URL = `/api/files/<键>`，
  越权键（`..`/绝对路径）一律 400。纯逻辑在 `common/utils/storage-keys.ts`。
- **文件引用统一归一**：数据库里可能是相对键、`/api/files/...` URL 或 JSON 内 URL，
  读取/归档/导出前一律走 `common/utils/storage-url.ts` 的 `storageKeyFromUrl()`，**不要各写一份解析**。
- **上传入口**：通用上传已改 `memoryStorage()` + `save()`（单文件 ≤50MB、单请求 ≤10 个），
  并由 `common/utils/upload-rules.ts` 拦截 html/svg/js/exe 等危险类型。
- **附件只存本地**（业务 2026-10-18）：不引入对象存储；文件清理采用“只读审计 + 人工确认”，
  不自动删除。审计脚本 `server/scripts/storage-audit.mjs`，结构说明见
  [docs/local-storage-structure.md](../../docs/local-storage-structure.md)。

## 采购工作流与合同联动

- **采购工作流有单一事实源**：后端 `constants/procurementFlow.ts` 与前端
  `web/src/constants/procurementWorkflow.ts` 是**互为镜像**的两份常量，由
  `frontendChainParity.spec.mts` 锁死。**必须同步改**，否则测试红。
- **合同阶段的任务状态由「主合同」决定**：纯函数 `contractStageTaskStatus()`（草稿→合同编制中 /
  审批中→合同审批中 / 已签章→已完成）；合同侧在签章、状态互转、提交、驳回时自动同步
  （`contract.service.syncLinkedTaskStatus`），`POST /procurement-tasks/:id/sync-contract-status` 只作人工兜底。
  ⚠️ 「主合同」= 该任务**最早创建**的合同（同批生成再按编号排序）；`GET /contracts` 按 `createdAt DESC`，
  **`list[0]` 不是主合同**，别拿它判定。
- **合同当前金额 = 主合同 + Σ 补充协议 `changeAmount`**（**带符号增量**，业务口径 2026-10-16）：
  单一实现在 `common/utils/contract-chain.ts` 的 `resolveChainAmounts()` / `contractChainAmount()`。
  ⚠️ **不要用补充协议的 `amount` 参与链式求和**——它是自由填写字段，涨价/降价时往往填的是
  "剩余数量的全价"，直接相加会**重复计入**；`changeAmount` 由服务端在发布时按清单重算
  （`common/utils/supplement-delta.ts`）。台账「已结算金额占合同比例」的分母、
  防超结上限、工作台红/黄预警**全部用这一个口径**。
  （`100% 欠款` 例外：基数已改为「审定结算额（总结算书 `SETTLED` 的 `totalAmount`）− 已付款」，
  无已定案总结算书时退回「开累结算额 − 已付款」，见 `deriveLedgerAmounts()` 的 `finalSettleAmount`。）
  ⚠️ 链 IO 只在 `contract-chain.ts`（不在 `amount-guard`）：`amount-guard` 被 `.mts` spec 加载，
  **不能新增相对 import**（见 `.claude/rules/testing.md`）。
- **金额上限（防超结/防超付）**：判定在零依赖模块 `common/utils/amount-guard.ts`
  （上限 = 合同链「主合同 + 补充协议」金额；累计结算排除草稿；累计付款排除失败/退款），
  策略由系统参数 `settlement.over_amount_policy` / `payment.over_amount_policy` 控制
  （`BLOCK`/`WARN`/`OFF`，默认 `WARN`）。⚠️ **合同链未填金额时返回 `null` = 无上限**，
  别把「无金额」当成上限 0（否则 BLOCK 下会拦住合法单据）。锁定：`amountGuard.spec.mts` +
  `test-integration/amount-guard.int.spec.ts`。链口径与策略取舍见 `common/utils/contract-chain.ts`
  与 `common/utils/amount-guard.ts` 的文件头注释。

## 日报 / 现场确认（结算量的来源）

- **日报行是结算量的唯一来源**：`DailyReport` 每行带现场确认状态 `confirmStatusCode`（dict
  `site_confirm_status`），状态只能经 `POST /daily-reports/confirm` 变更（`create/update` 不接受直传）；
  口径开关 `settlement.require_confirmed`（默认 `true`）开启时，非「已确认」的现场记录**不计入结算口径**
  （`contract-settled-qty` 会过滤）；收领单推送生成的行由 `receipt-order.service` 直接置「已确认」。
  ⚠️ 改 `web/src/pages/DailyReports.tsx` 的 `FIELDS` 时，**key 必须与 Prisma 模型字段逐字一致**
  （该数组同时驱动表格列与表单字段，错一个字 = 列空白 + 保存 500）。口径细节见
  `daily-report.service.ts` 与 `constants/workflowGuards.ts` 的文件头注释。

## 台账

- **发票金额口径统一走 `countedInvoiceWhere()`**（业务口径 2026-11-12）：作废 `CANCELLED` / 红冲 `RED`
  不计入任何发票金额列（台账「本月开票额」「开累发票金额」、履约开票比例、工作台累计发票额、AI 统计）；
  **空状态历史票仍计入**。禁止裸写 `NOT: { statusCode: { in } }`——SQL 三值逻辑会静默漏掉 NULL 行；
  查询里已有 `OR` 时必须用 `AND` 包裹（`computeLedgerAutoFields` 即此情形）。终态只能经
  `POST /invoices/:id/cancel|red` 进入，通用 PUT 拒绝状态进出终态；终态**保留 `settlementId`** 关联。
  **红冲票与原票**：`Invoice.redOfInvoiceId` 自关联；新建红冲票（`statusCode = RED`）时若带原票 id，
  服务端必须在**同一事务**里把原票置 `CANCELLED`（否则会出现「红冲票已入库、原票仍有效」的半成功，
  两张票都计入金额口径）；原票须有效且同项目同合同，**关联只能在新建红冲票时建立**（编辑态 PUT 一律拒绝），
  关联创建后不可改；删红冲票不恢复原票。台账同步时纯自动产生的空行会被剪除（不做 0 元幽灵行）。
  红冲票与原票**两侧都不能换合同**：`update()` 在请求**省略 `redOfInvoiceId`** 时也要按已有关联校验
  同合同，并拦住「已被红冲的原票改 `contractId`」（否则审计关系会跨合同）。
  ⚠️ 作废原票必须用**条件更新**（`updateMany({ where: { id, ...countedInvoiceWhere() } })` + `count === 1` 校验）：
  校验与写入之间的并发窗口会让同一张原票被红冲两次；`markTerminal()` 同样用条件更新避免「响应说已作废、
  库里却是红冲」的假成功。

- **台账行与结算单 1:1**（业务口径 2026-10-16）：`SettlementLedger.settlementId`（**唯一键**）指向该行对应的结算单，
  由 `settlement.service.syncLedgerByContract()` 统一维护（结算单 create/update/remove 后自动调用；
  改造前这个函数**全仓没有调用点**，台账只能手动刷新，这正是"看不出关联"的根因）。
  ⚠️ **同合同同月只允许一张结算单**（`assertMonthUniqueForContract()` 在登记时 400 拦住并提示已有单号）——
  台账的结算额/发票额/资金费用都是按**月**归集的，同月两张无法归属。
  ⚠️ **改月份时必须"先清后挂"**：`settlementId` 是唯一键，结算单从 A 月挪到 B 月时若不先清掉 A 月行上的链接，
  B 月建行就会撞唯一约束（真库实测踩到；`syncLedgerByContract` 里已把"清空 + 逐月 upsert"放进一个事务）。
- **`settlementId` 可以为空 = 「仅费用行」**：当月**没有结算单但有资金费用/逾期利息**时，台账行照样要生成
  （`monthSettleAmount = 0`）。"结算单驱动"与"仅费用驱动"两条路径**汇合在同一个 `upsertLedgerRow()`**，
  不要在别处手拼台账的自动字段。
- **只读派生列（8 个）**：`factoringDiscount`（资金费用台账）、`overdueInterest`（逾期利息台账），
  以及由结算单/发票派生的 `monthSettleAmount` / `settleCount` / `yearSettleAmount` /
  `cumPurchaseAmount` / `startSettleAmount` / `monthActualPurchase`。
  `computeLedgerAutoFields()` 每次保存/刷新都会覆盖它们，故 `updateLedger()` / `createLedger()` 收到一律 **400**
  （**不静默忽略**——静默会让人以为改成功了）；前端台账表单也置灰并在提交前剥掉这 8 个 key。
  唯一例外是台账 **Excel 导入**（`createLedger(data, projectId, tx, { fromImport: true })`：
  导入模板仍带「保理贴息/逾期利息」，且它们本来就会被自动字段覆盖，行为与改造前一致）。
  锁定：`settlement-link.int.spec.ts`。
- **派生金额的"三态"契约（未填 ≠ 0）**：台账里由合同额/结算额推出来的列（`已结算金额占合同比例`、
  `应付款金额`、`应付未付`、`已付款占结算比例`）**必须**走
  `common/utils/ledger-derived.ts` 的 `deriveLedgerAmounts()`，**不要就地写算式**：
  合同额未填（`NULL`/空串）时这些列要返回 `null`（前端显示 `-`、导出留白），
  **不能兜成 0**——`0 − 已付款` 是负数、`结算/0` 是"谎称未结算"，而同一批合同在防超结闸门里
  的口径是"上限未知"（`contractChainAmount()` 返回 `null`）→ 会造出"同一件事两个相反结论"。
  ⚠️ **显式填 `0` 是真实的 `0`**（与 `amount-guard` 一致），照常参与计算：0 元合同却有付款
  算出的负欠款**正是该被看见的数据异常**，别抹平。锁定：`ledgerDerived.spec.mts`。
  ⚠️ `100% 欠款` 已不再依赖合同额：基数 = `finalSettleAmount ?? cumSettleAmount`（见上条），
  无已定案总结算书时即「开累结算额 − 已付款」，故合同额未填也能算出。
- **「累计结算」有两个口径，是有意区分的，别去"统一"**：台账列「已结算金额占合同比例」的分子用
  **开累结算金额**（`SettlementLedger.monthSettleAmount`，由结算/发票/保理/逾期派生）；
  防超结闸门与工作台预警的分子用**结算单口径**（`Settlement.actualAmount`）。前者回答"这条链的账现在是多少"，
  后者回答"有没有超结"，实测当前数据两者逐条相等；某月只有发票/保理而无结算时会分开，
  届时应以台账列为准、并在预警里说明分母。
- **「合规性问题」是内存派生列，筛选必须走「窄投影算命中 id → 只回查当页」**（2026-11-22）：
  库里没有这一列，规则是纯函数 `ledger-compliance.ts` 的 `calcLedgerCompliance()`
  （合同类型 + 进场 / 招标 / 定标 / 签订四个日期）。**不要**把全项目合同与 6 张附表都取回内存再过滤切片
  （5000 份合同 = 搬 5000 行合同 + 数万行附表，而真正展示的只有 ≤ take 行）；
  应先用 `matchComplianceIds()` 只取 4 列窄投影 + `dailyReport.groupBy(_min entryDate)` 算出命中 id，
  再按页回查完整行（`id: { in: pageIds }` 不保证顺序，要按命中顺序回排）。
  ⚠️ **判定只有一份实现**：不要为了筛选再写一版 SQL 规则（口径分两处，改一处必漏另一处）。
  锁定：`ledger-compliance-filter.int.spec.ts`（六种结果各自命中 · `total` 为命中条数 · 跨页不重不漏 · 顺序不变）。
- **列宽的单位契约**：`modules/ledger/ledger-columns.ts` 的 `LEDGER_COLUMNS[].width` 是
  **Excel 字符宽（8~30）**，输出前由 `ledgerColumnWidthPx()`（≈8px/字符、100px 下限）换算成**像素**。
  **不要把字符宽当像素交给 antd**（会把 42 列表头挤成竖排文字，桌面端也破版）。锁定：`ledgerColumns.spec.mts`。

## 付款安排与「当前生效比例」（2026-10-16 加的批次）

- **付款安排（`Contract.paymentMode`）是合同字段**，取值 `100` / `3382` / `M65_1` / `M65_3` / `CUSTOM`，
  定义与文案在零依赖模块 `common/utils/pay-ratio.ts`（`PAYMENT_MODES`）——**前端下拉是它的镜像**
  （`web/src/constants/paymentModes.ts`），由 `payRatio.spec.mts` 锁住「取值集合 + label 逐条相等」。
  取值不合法一律 **400**（写错会让派生比例错、进而让台账列与付款预警都错，从界面还看不出来）。
- **`ContractExt.currentPayRatio` 是服务端派生列**，唯一实现在 `contract.service.syncPayRatio()`：
  ① `execStatus = DONE_SETTLED`（已完已结 = 总结算已办理）→ **1.0**；② 否则按付款安排的**月度比例**
  （`100`/`3382` → 1，`M65_1`/`M65_3` → 0.65）；③ `CUSTOM` → 用 `ContractExt.settlementPayRatio`（合同上手填）；
  ④ **推不出来 → `null` 且保持原值不动**（"未知"不该被改写成某个数；手填 0 也算推不出来）。
  ⚠️ 台账「当前合同付款比例」列、逾期引擎的 `paymentRatio`、工作台付款预警**都读这一列**。
  ⚠️ 合同表单里它已改为**只读展示**、提交时前端会把它剥掉（`web/src/components/contract/ContractEditor.tsx` 的 `submit`）。
- **付款超比例预警**（工作台）：纯函数 `common/utils/amount-alert.ts` 的 `evaluatePaymentRatioAlert()`
  —— 开累付款 > 开累结算 × 生效比例；**单级**（业务只给了"超过就报"）；比例未填/为 0 或开累结算为 0
  → **不报**；"恰好等于上限"不算超。开累付款的分子排除 `PAYMENT_EXCLUDED_STATUSES`（失败/退款，
  与防超付闸门/台账同一份常量）。
  ⚠️ 它与「合同金额预警」（结算是否超合同额）是**两个信号**，工作台分列展示，**不要合并**；
  两者都只展示、不拦单据——拦不拦由 `*_over_amount_policy` 决定。

## 结算期与自动生成（2026-10-16 加的批次，改发票/收领单/结算单前必看）

- **归属判据是「结算期」，不是自然月**：唯一实现在零依赖模块 `common/utils/settlement-period.ts`
  （`currentSettlementPeriod` / `previousSettlementPeriod` / `periodKeyOf` / `periodMonthKey`），
  期的起始日取自 `Project.settlementStartDate`（未设置 = 1 日 = 自然月）。
  ⚠️ 起始日不是 1 日时**期会跨自然月**（起始日 26 → 期 9/26–10/25）：9/28 的收领单与期末 10/25 的结算单**同期**，
  用自然月比会误判成"不同月"而拒绝关联。**别在各 service 里自己拼 `getFullYear/getMonth`**。
- **发票/收领单 ↔ 结算单：自动匹配为主 + 人工可指定**（一张结算单对多张）。
  `findSettlementIdFor()` 在保存时按同期自动找；请求显式带 `settlementId`（含 `null` = 解绑）按人工指定，
  先过 `assertLinkable()`（同项目/同合同/同期，违反 **400**）。发票的「日期」= `结算账期` 解析出的月份 **1 日**，
  认不出才退回开票日期。⚠️ 关联变化会影响台账「本月开票额」，调用方随后**必须** `syncLedgerByContract()`；
  `linkOrphansForContract()` 是"先解绑再补挂"，**只动未关联的行**（不覆盖人工选择，除非它与期矛盾）。
- **生成结算单必须幂等**（`generateForPeriod()`，业务口径 2026-10-18）：**来源是上一期的总日报行**
  （含手工录入行；`settlement.require_confirmed` 开启时只取「已确认」行），按**物资合同**各生成一张
  **草稿**（`settleDate` = **期末** → 台账月份由它派生，两边必须同口径），明细按 `materialBaseId` 从日报带出、
  **允许人工修改**；期内收领单回挂 `settlementId`（发票/台账按关联归集），但**不参与明细金额计算**。
  该合同本期**已有结算单 → 跳过并补挂**迟到的收领单（**只补关联、不改金额**：金额可能已定稿甚至已提交）。
  ⚠️ 明细金额 = Σ 日报金额；缺 `materialBaseId` 的行计入 `skippedRows`，**`settleQty` 为空或为 0** 的行
  计入 `skippedNoQtyRows`，两类都返回 `warnings`（不静默丢；无数量行也不得混入加权平均）。
  **负数是退货 / 材料调出**（业务 2026-11-17）：照常参与同物资聚合、按净额冲减本期结算；正负完全抵消
  （净数量 0）的分组无法表示成「单价 × 数量」，计入 `skippedNetZeroRows` 并告警，不生成 0 数量明细。
  纯函数在 `common/utils/settlement-from-daily.ts`（价格公式与 `SettlementService.normalizeItem()` 同一份，
  保证表头金额 = Σ 明细合价）；生成时「单头 + 明细 + 收领单回挂」在同一事务内，失败不留孤儿结算单。
  ⚠️ 它是**手动按钮**触发的（仓库不引入调度器），前端另有「上一期未生成」提示。
  锁定：`settlementPeriod.spec.mts` + `settlementFromDaily.spec.mts` + `test-integration/settlement-period-link.int.spec.ts`。

## 事务边界（2026-11-23 定的口径）

门禁：`node scripts/check-tx-boundaries.mjs`（CI + `verify-module`；带 `--self-test`）。

### 允许 / 不允许

- **只做数据库操作**：`$transaction` 回调里除了传进来的 `tx`，不要再做别的。
- **禁止 `await this.<x>Service.method()`**：跨域 service 塞进事务 = 长事务 + 隐式耦合；
  对方内部随时可能再开事务或发通知，范围失控。需要跨模块写表 → 用 owner 导出的
  **无状态写入原语**（第一个参数是事务句柄），见 [module-boundaries.md](module-boundaries.md) §3.2。
- **禁止外部 IO**（HTTP / 文件读写 / 生成下载）：耗时不可控，期间一直持有连接与行锁；
  Prisma 交互式事务在 PostgreSQL 上是**单连接长事务**，慢 IO 会把连接池打穿。
  导出/落盘一律放在事务**提交之后**（或走 `RunOptions.afterCommit`）。

### 超时口径

- 默认（`maxWait` 2s / `timeout` 5s）优先；**必须显式放宽时**写清理由，并同时给 `maxWait`。
- 当前两处放宽到 15s 的全部在这两处：`invoice.service.ts`（红冲票 + 作废原票同事务）、
  `settlement-ledger.service.ts`（清关联 → 逐月 upsert → 剪空行，语句数随月份数增长）。
- 若因数据量超时，**先改分批（每批一个事务），不要靠调大 timeout 硬扛**。

### 不可拆事务清单（拆了会静默失去正确性）

这两处的事务范围**本身承载语义**，不要"优化"成两个事务或把锁挪到事务外：

| 位置 | 为什么不能拆 |
|---|---|
| `settlement.service.ts` 的 `pg_advisory_xact_lock('settlement-period', …)` | 咨询锁**随事务提交/回滚自动释放**；拆成两个事务后，锁在写入前就释放，跨期并发的互斥失效（无报错、只是偶尔重复生成） |
| `common/services/import-task.service.ts` 的导入去重锁 | 同上：锁与"检查是否已导入 + 写任务行"必须同事务，否则并发导入会双写 |

新增这类"锁 + 写入"组合时，同样要写在同一事务里，并在本表登记。

- **导入的收尾动作走 `RunOptions.afterCommit`**：发票导入后要挂结算单并刷台账，而这件事必须**读得到刚提交的数据**
  （事务内读不到未提交行）→ 写在 runner 的 `afterCommit`（同步与异步两条导入路径都覆盖），
  且失败**只记日志、不改变导入结果**（数据已提交，"少刷一次台账"比把导入标成失败轻得多）。
