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

- **乐观锁**：业务表多有 `version Int`，更新时用 `helpers.assertVersion(old, data)`（不一致抛 409）。
- **写字段白名单**：service 用 `common/pick-fields.ts` 的 `pickFields` 过滤未知字段，防前端字段漂移 500。
- **日志必须脱敏（白名单）**：操作日志拦截器把「请求参数 + 变更前后快照」整体写入 `OperationLog`
  （日志页仅需 `system:user` 权限即可查看），**凭据/银行账号/证件号/联系方式不得明文入库**。
  规则集中在 `common/utils/mask.ts`（`slimSecrets()` 深拷贝后按键名打码，**不改原对象**——入参可能是
  即将返回给前端的响应体）；新增敏感字段须登记进 `SECRET_FIELD_KEYS`，契约由 `mask.spec.mts` 锁定。
- **文件落盘只有一条路**：`common/services/storage.service.ts`（`StorageService`，上传/签章件/导入错误报告
  三个写入点都走它）——**不要在 service/controller 里自己拼 `UPLOAD_DIR` 与文件名**；键是**相对 POSIX 路径**
  （`signed/x.pdf`，用 `/` 不用 `path.join`，否则 Windows 下落库成 `signed\x.pdf`），对外 URL = `/api/files/<键>`，
  越权键（`..`/绝对路径）一律 400。纯逻辑在 `common/utils/storage-keys.ts`。
  ⚠️ multer 的 `destination/filename` 回调在**类定义期**求值，`this` 不是控制器实例——别在那里注入式取服务。
  换对象存储只需实现同一个 `StorageLike` 并改 `common.module.ts` 的 provider 绑定 + `main.ts` 静态服务。
  细节见 [docs/component-api.md](../../docs/component-api.md)。

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
  （`common/utils/supplement-delta.ts`）。台账「已结算金额占合同比例」「100% 欠款」的分母、
  防超结上限、工作台红/黄预警**全部用这一个口径**。
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
- **`factoringDiscount` / `overdueInterest` 是只读派生列**：分别来自「资金费用台账」与「逾期利息」，
  `updateLedger()` / `createLedger()` 收到它们一律 **400**（**不静默忽略**——静默会让人以为改成功了）；
  前端台账表单也置灰并在提交前剥掉这两个 key。唯一例外是台账 **Excel 导入**
  （`createLedger(data, projectId, tx, { fromImport: true })`：导入模板仍带这两列，
  且它们本来就会被自动字段覆盖，行为与改造前一致）。锁定：`settlement-link.int.spec.ts`。
- **派生金额的"三态"契约（未填 ≠ 0）**：台账里由合同额/结算额推出来的列（`100% 欠款`、
  `已结算金额占合同比例`、`应付款金额`、`应付未付`、`已付款占结算比例`）**必须**走
  `common/utils/ledger-derived.ts` 的 `deriveLedgerAmounts()`，**不要就地写算式**：
  合同额未填（`NULL`/空串）时这些列要返回 `null`（前端显示 `-`、导出留白），
  **不能兜成 0**——`0 − 已付款` 是负数、`结算/0` 是"谎称未结算"，而同一批合同在防超结闸门里
  的口径是"上限未知"（`contractChainAmount()` 返回 `null`）→ 会造出"同一件事两个相反结论"。
  ⚠️ **显式填 `0` 是真实的 `0`**（与 `amount-guard` 一致），照常参与计算：0 元合同却有付款
  算出的负欠款**正是该被看见的数据异常**，别抹平。锁定：`ledgerDerived.spec.mts`。
- **「累计结算」有两个口径，是有意区分的，别去"统一"**：台账列「已结算金额占合同比例」的分子用
  **开累结算金额**（`SettlementLedger.monthSettleAmount`，由结算/发票/保理/逾期派生）；
  防超结闸门与工作台预警的分子用**结算单口径**（`Settlement.actualAmount`）。前者回答"这条链的账现在是多少"，
  后者回答"有没有超结"，实测当前数据两者逐条相等；某月只有发票/保理而无结算时会分开，
  届时应以台账列为准、并在预警里说明分母。
- **列宽的单位契约**：`modules/ledger/ledger-columns.ts` 的 `LEDGER_COLUMNS[].width` 是
  **Excel 字符宽（8~30）**，输出前由 `ledgerColumnWidthPx()`（≈8px/字符、100px 下限）换算成**像素**。
  **不要把字符宽当像素交给 antd**（会把 42 列表头挤成竖排文字，桌面端也破版）。锁定：`ledgerColumns.spec.mts`。
