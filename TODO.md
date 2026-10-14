# TODO.md · 剩余任务

> **本文件只列「未完成」任务**：完成一项就**直接删除条目**（不用 `[x]` 勾选、不写"已完成"段落，
> 否则文件只增不减）；历史以 `git log` / PR 为准。
> 改动前必读的约定与踩过的坑见 [AGENTS.md](AGENTS.md) 与 [.workbuddy/memory/MEMORY.md](.workbuddy/memory/MEMORY.md)。
> 数据来源：对当前代码库的审计（非产品需求方录入），请按实际排期调整。
> **基准**：main @ `2031def`（2026-10-14）；最近一批已完成 P3 的「采购清单→合同清单衔接」、
> 「金额计算补测（逾期利息引擎 + 台账合规判定）」与「日报页年份千分位」。

图例：`P1` 应尽快（阻塞在外部输入）· `P2` 需业务澄清（未澄清前不要动手）· `P3` 可直接开工（工程项）

## P1 · 应尽快（阻塞在外部输入）

- **发票查验接第三方**：`POST /invoices/:id/verify` 目前是**演示实现**——`invoice.service.ts` 的
  `verify()` 直接返回 `{ verified: true, provider: 'MOCK' }`，代码内留着
  `TODO: 接入第三方查验（如航信/百望）后替换此处实现`。需先在需求侧确认服务商与接口协议。
  （注：`invoice-recognizer.ts` 只做二维码/OCR 识别，不构成"查验"。）

## P2 · 需业务澄清（未澄清前不要动手）

> 按错方向做会**造出两套口径或推翻既有决策**，故先澄清再排期。前 4 条来自
> [docs/09](docs/09-重构方案评估与采纳建议.md) §7。

- **付款是否恢复「计划 / 申请 / 核销（三单匹配）」三级模型**：现状是**有意收敛**的单表付款台账
  （`PaymentRecord`；[docs/07](docs/07-工作域信息关联审计.md) §3.2 明确「不做三单匹配」，
  2026-10 又清理了遗留死字段 `applyId`）。外部方案主张回退三级模型 → 需业务定夺。
- **合同正文导出取「签订时快照」还是「当前主数据」**：现状取**实时**（`template.service.generate()`
  读 `sup.bankName / legalPerson / contactPhone`…），供应商改名或换银行会改变历史合同**再导出**的内容；
  相关系统参数 `supplier.name.sync.history`（KEEP/SYNC）**已声明但从未实现**（全仓无读取点）。
  若确认要快照，最小实现是在 `contract.service.sign()` 时快照进合同，**不改**「主表只存 supplierId」的结构。
- **变更口径**：继续用「补充协议」表达合同变更，还是引入「变更单/签证」并累计变更金额（`changeAmount`）？
  这决定「合同当前金额」上限口径（影响防超结的上限），也决定清单项级结算明细能否落地。
- **审批流是否需要可配置**（按金额/合同类型/组织走不同审批路径）：现状无 `Approval*` 模型，
  合同 = `status` + `/sign` + `/reject`、结算 = `statusCode` + 驳回。若需要，按 [docs/05](docs/05-四域扩展可行性评估.md) §5
  自研「流程定义/节点/实例/记录」四表（**不要 Flowable**，Java 生态与本栈不匹配）。
- **`/contracts` 旧合同编辑页去留**：该页（675 行，含四种条款选择）仅能通过旧 URL 进入，新菜单无对应入口
  （起草/查询分别由 `/contract/draft`、`/contract/query` 承担）。需确认是合并到 `/contract/draft`
  还是补回菜单；**确认前不要删**。
- **公告与采购文件的「采购时间」同名各存**：两页各有独立可编辑字段（同义、分别落库）。已登记进
  `SHARED_ACROSS_MODULES` 白名单并注明，待确认是否需要统一来源。
- **`SettlementLedger` 与结算单是否要强关联**：目前只靠 `contractId + settleMonth` 聚合
  （[docs/07](docs/07-工作域信息关联审计.md) §4 已声明「不强关联」）。若业务需要「一结算单对多台账行」，
  再补 `settlementId` FK。

> **关联依赖**：**清单项级结算明细（`SettlementItem`）** 与「结算量 ≤ 已确认量」的**量级校验**依赖上面的
> 「变更口径」澄清——否则会与补充协议口径打架（这也是 [docs/09](docs/09-重构方案评估与采纳建议.md) §4 缺口 E）。
> 澄清后再立项；在此之前，现场确认的闸门只作用到金额与"已确认量"提示层面。

## P3 · 可直接开工（工程项，按性价比排序）

1. **单花括号 / 英文遗留 key 的存量盘点与迁移**：`template.service.generate()` 仍兼容 `{变量名}`、
   `{{MATERIAL_CODE_TABLE}}`、`{合同额大写}` 等。**2026-10-14 实测**：库中 4 份合同模板里有 **1 份**
   （物资采购执行合同模板）同时使用英文 key 与 `{合同额大写}` → **不能直接删分支**，先把这 1 份模板迁到
   `{{}}` 规范再移除兼容逻辑（移除属破坏性变更，需单独排期）。
2. **台账/看板列配置扩展到更多列表页**：`ledger.columns.config`（`ledger.service.ts` 读写 + 页面列设置弹窗）
   已是可用范式，可抽成通用组件供其他列表页复用。
3. **`ImportTask` 崩溃恢复**：模型**无 `lockedAt` 字段**，进程重启后卡在 `RUNNING` 的任务无法重投。
   建议补 `lockedAt` 心跳 + 超时重投 + 幂等键（需要真队列时再上 **pg-boss**，基于 PG、无需 Redis）。
4. **上传目录替换为对象存储**：`FileController` 用 multer `diskStorage`，是**唯一写入点**（表里只存 URL），
   替换实现即可接 MinIO/S3；顺带可加哈希校验与版本管理。
5. **日志脱敏白名单 + 展示脱敏 `maskField()`**：现状**无 `maskField`**，唯一"脱敏"是操作日志对
   `password` 打码。可参考 `common/pick-fields.ts` 的写法加 `maskField()`（行级 DataScope 视诉求）。

6. **合并重复的「累计口径」计算**（2026-10-14 实施中发现的重复逻辑，**改动前先补测**）：
   `overdue-calculator.recalculate()` 的 `stats` 已算出 `totalMaterial / totalPayment / currentCumulative /
   prevCumulative / cumulativeByMonth`，而 `finance.service.listOverdue()` **又各算了一遍**；
   且两处「上期开累」规则不同——引擎按「行内 `prevCumulative` 优先，否则上一结算月开累」，
   `listOverdue` 取「最新月份那条带手动期初的行」。两套口径会漂移，建议收敛到一处
   （注意 `listOverdue` 支持按 `settlementMonth` 过滤，收敛时要保留「筛选视图 vs 全量计算」的差异）。

## 四域扩展（评估已定，待实施）

> 依据 [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md)。**以下均为待排期任务，尚未实施。**

### 已定决策（2026-10-13）

- **招标域 = 设计 A**：招标作为**采购方式**并入现有采购工作流（与 `procurement_source` 字典语义一致），
  仅新增 `ProcurementBidder` + `ProcurementEvaluation` 两张结构化表，其余复用。
- **进出场 = 只做物资**：复用 `AssetLedger` / `DailyReport` / `ReceiptOrder`，**不建表**、不做人员/车辆。
- **技术栈 = 沿用现有**；不引入微服务 / API 网关 / Redis / MQ / MongoDB / Flowable / Seata / 电子签章 / 低代码平台。

### 待实施 · 先设计后开发

- **单据关系设计（先做）**：采购任务 → 合同 → 采购订单 → 收货 → 对账 → 结算；明确与现有收领单/结算的复用边界。
- **招标域**：`ProcurementBidder` + `ProcurementEvaluation` + 页面 + 定标→合同衔接
  （复用 `generateLinkedContract` 写法）。
- **采购下游**：`PurchaseOrder`(+Item) → 到货验收（**复用收领单**，加 `purchaseOrderId`）→ `Reconciliation`。
- **合同增强**：履约派生进度（零表）→（按需）`ContractFulfillment` → 归档锁定。

> 注：上面 P3 第 1 条（采购清单 → 合同清单衔接）与四域扩展的「采购下游」是同一段链路的两端，
> 可一并排期——先做衔接（无新表），再做订单/对账（要新表）。

### 待实施 · 按需

- 通知通道适配器（站内信之外加企微/钉钉机器人 Webhook）。
- 移动刚需页 H5 精简版（全站响应式已完成，见 [docs/08](docs/08-全局响应式改造方案.md) §0.1）。
- 可选：半结构化字段改 PG `jsonb`、招标立项前置状态、`DailyReport.exitDate`。

## 本文件的维护方式

1. **完成即删除**：任务做完直接从本文件删条目，不留 `[x]`、不追加"最近完成"章节。
2. **新增任务**：只写「未完成、可执行」的事项，附证据（文件/接口/命令）与**阻塞原因**；
   按"是否需要业务澄清"分流到 P2 或 P3。
3. **需要长期记住的约定与坑**：**不要写在本文件**——写进 [AGENTS.md](AGENTS.md)（改动前必读的硬约定）
   或 [.workbuddy/memory/MEMORY.md](.workbuddy/memory/MEMORY.md)（背景、成因、易错点）。
4. 与 [AGENTS.md](AGENTS.md) 的「验收铁律」配合使用：改完必须过构建 + 单测 + 真打请求。
