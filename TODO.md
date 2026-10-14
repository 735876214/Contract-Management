# TODO.md · 剩余任务

> **本文件只列「未完成」任务**：完成一项就**直接删除条目**（不用 `[x]` 勾选、不写"已完成"段落，
> 否则文件只增不减）；历史以 `git log` / PR 为准。
> 改动前必读的约定与踩过的坑见 [AGENTS.md](AGENTS.md) 与 [.workbuddy/memory/MEMORY.md](.workbuddy/memory/MEMORY.md)。
> 数据来源：对当前代码库的审计（非产品需求方录入），请按实际排期调整。
> **基准**：main 分支 2026-10-14（具体提交见 `git log`）。最近一批已完成：P3 的「采购清单→合同清单衔接」、
> 「金额计算补测（逾期利息引擎 + 台账合规判定）」、「日报页年份千分位」、「字段级展示脱敏的日志侧」、
> 「`ImportTask` 崩溃恢复 + 幂等去重」、「合同模板占位符语法收敛（移除单花括号/英文 key 兼容分支）」、
> 「逾期利息汇总口径合并为单一实现」。

图例：`P2` 需业务澄清（未澄清前不要动手）· `P3` 可直接开工（工程项）
> 说明：**发票「查验」仅用于登记核对（把发票信息录入后标记为已查验），不做验真、不接第三方查验服务**，
> 故此项已按业务澄清从待办中移除。

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

1. **上传目录替换为对象存储**：落盘写入点原有 **3 处**（`file.controller.ts` 的 multer、`contract.service.sign()`
   的签章件、`import-task.service` 的导入错误报告），已统一收敛到 `common/services/storage.service.ts`
   （`StorageLike` + `LocalStorageService`；目录/命名/越权校验/URL 都收在这一层）。
   剩下的工作：实现 `S3StorageService`（MinIO/S3）、在 `common.module.ts` 换 provider 绑定，
   并把 `main.ts` 的静态服务 `useStaticAssets` 改为代理或 302 重定向（**无基础设施时无法验收，故未做**）；
   顺带可加哈希校验与版本管理。
2. **字段级展示脱敏（按权限打码）**：脱敏工具 `common/utils/mask.ts` 已具备
   （`maskField()` / `maskByKey()` / `slimSecrets()`），**日志侧已强制脱敏**；
   剩下的是「**响应体按角色打码**」——需业务先定"哪些角色看不到哪些字段"，
   再仿 `common/pick-fields.ts` 的写法在序列化处接入（行级 DataScope 视诉求，见 [docs/05](docs/05-四域扩展可行性评估.md) §9）。

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

> 注：四域扩展的「采购下游」与已完成的「采购清单 → 合同清单衔接」是同一段链路的两端——
> 衔接已做（无新表），后续再做订单/对账（要新表）。

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
