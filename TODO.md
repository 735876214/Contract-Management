# TODO.md · 剩余任务

> **本文件只列「未完成」任务**：完成一项就**直接删除条目**（不用 `[x]` 勾选、不写"已完成"段落，
> 否则文件只增不减）；历史以 `git log` / PR 为准。
> 改动前必读的约定与踩过的坑见 [AGENTS.md](AGENTS.md) 与 [.workbuddy/memory/MEMORY.md](.workbuddy/memory/MEMORY.md)。
> 数据来源：对当前代码库的审计（非产品需求方录入），请按实际排期调整。

图例：`P1` 应尽快 · `P2` 改进项 · `P3` 可选

## P1 · 应尽快（阻塞在外部输入）

- **发票查验接第三方**：`POST /invoices/:id/verify` 目前只做二维码识别
  （`server/src/modules/invoice/invoice-recognizer.ts`），未接查验服务。需先在需求侧确认服务商与接口协议。

## P2 · 改进项（需业务确认后再动）

> 以下 4 条来自外部重构方案评估（[docs/09](docs/09-重构方案评估与采纳建议.md) §7）：**未澄清前不要动手**，
> 否则会造出两套口径或推翻既有决策。

- **付款是否恢复「计划 / 申请 / 核销（三单匹配）」三级模型**：现状是有意收敛的单表付款台账
  （`PaymentRecord`；`docs/07` §3.2 明确「不做三单匹配」）。外部方案主张回退三级模型。
- **合同正文导出取「签订时快照」还是「当前主数据」**：现状取实时（供应商改名/换银行会改变历史合同再导出的内容）；
  相关系统参数 `supplier.name.sync.history`（KEEP/SYNC）**已声明但从未实现**（全仓无读取点）。
- **变更口径**：继续用「补充协议」表达合同变更，还是引入「变更单/签证」并累计变更金额（`changeAmount`）？
  这决定「合同当前金额」上限口径，也决定清单项级结算明细（SettlementItem）能否落地。
- **审批流是否需要可配置**（按金额/合同类型/组织走不同审批路径）：现状无 `Approval*` 模型，
  合同=`status`+`/sign`+`/reject`、结算=`statusCode`+驳回。若需要，按 `docs/05` §5 自研四表（**不要 Flowable**）。

- **`/contracts` 旧合同编辑页去留**：该页（675 行，含四种条款选择）仅能通过旧 URL 进入，新菜单无对应
  入口（起草/查询分别由 `/contract/draft`、`/contract/query` 承担）。需业务确认是合并到 `/contract/draft`
  还是补回菜单；**确认前不要删**。
- **公告与采购文件的「采购时间」同名各存**：两页各有独立可编辑字段（同义、分别落库）。已登记进
  `SHARED_ACROSS_MODULES` 白名单并注明，待业务确认是否需要统一来源。
- **单花括号 / 英文遗留 key 的替换分支移除**：`template.service.generate()` 仍兼容 `{变量名}`、
  `{{MATERIAL_CODE_TABLE}}`、`{合同额大写}` 等。规范已定为 `{{}}` 并加了废弃标注，但**实测库中
  1/4 模板（物资采购执行合同模板）仍在使用**，移除属破坏性变更，需先盘点/迁移存量模板。
- **`SettlementLedger.settlementId` 待确认**：结算台账与结算单目前只靠 `contractId + settleMonth` 聚合
  （已在 [docs/07](docs/07-工作域信息关联审计.md) 声明"不强关联"）。若业务需要「一结算单对多台账行」
  的强关联，再补 FK。

## P3 · 可选增强（与四域扩展无关的工程项）

- 台账/看板的列配置持久化已具备（`sys_param: ledger.columns.config`），可扩展到更多列表页。
- 上传目录可替换为对象存储（`FileController` 是唯一写入点，替换实现即可）。
- `ImportTask` 崩溃恢复（`lockedAt` 心跳 + 幂等键）；需要真队列时上 **pg-boss**（基于 PG，无需 Redis）。
- 日志脱敏白名单 + 展示脱敏 `maskField()`（行级 DataScope 视诉求）。

## 四域扩展（评估已定，待实施）

> 依据 [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md)。**以下均为待排期任务，尚未实施。**

### 已定决策（2026-10-13）

- **招标域 = 设计 A**：招标作为**采购方式**并入现有采购工作流（与 `procurement_source` 字典语义一致），
  仅新增 `ProcurementBidder` + `ProcurementEvaluation` 两张结构化表，其余复用。
- **进出场 = 只做物资**：复用 `AssetLedger` / `DailyReport` / `ReceiptOrder`，**不建表**、不做人员/车辆。
- **技术栈 = 沿用现有**；不引入微服务 / API 网关 / Redis / MQ / MongoDB / Flowable / Seata / 电子签章 / 低代码平台。

### 待实施（P1 级 — 先设计后开发）

- **单据关系设计（先做）**：采购任务 → 合同 → 采购订单 → 收货 → 对账 → 结算；明确与现有收领单/结算的复用边界。
- **招标域**：`ProcurementBidder` + `ProcurementEvaluation` + 页面 + 定标→合同衔接
  （复用 `generateLinkedContract` 写法）。
- **采购下游**：`PurchaseOrder`(+Item) → 到货验收（**复用收领单**，加 `purchaseOrderId`）→ `Reconciliation`。
- **合同增强**：履约派生进度（零表）→（按需）`ContractFulfillment` → 归档锁定。

### 待实施（P2/P3 — 按需）

- 通知通道适配器（站内信之外加企微/钉钉机器人 Webhook）。
- 移动刚需页 H5 精简版（全站响应式已完成，见 [docs/08](docs/08-全局响应式改造方案.md) §0.1）。
- 可选：半结构化字段改 PG `jsonb`、招标立项前置状态、`DailyReport.exitDate`。

## 本文件的维护方式

1. **完成即删除**：任务做完直接从本文件删条目，不留 `[x]`、不追加"最近完成"章节。
2. **新增任务**：只写「未完成、可执行」的事项，附证据（文件/接口/命令）与**阻塞原因**。
3. **需要长期记住的约定与坑**：**不要写在本文件**——写进 [AGENTS.md](AGENTS.md)（改动前必读的硬约定）
   或 [.workbuddy/memory/MEMORY.md](.workbuddy/memory/MEMORY.md)（背景、成因、易错点）。
4. 与 [AGENTS.md](AGENTS.md) 的「验收铁律」配合使用：改完必须过构建 + 单测 + 真打请求。
