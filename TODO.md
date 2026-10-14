# TODO.md · 剩余任务

> **本文件只列「未完成」任务**：完成一项就**直接删除条目**（不用 `[x]` 勾选、不写"已完成"段落，
> 否则文件只增不减）；历史以 `git log` / PR 为准。
> 改动前必读的约定与踩过的坑见 [AGENTS.md](AGENTS.md)（**唯一事实源**；历史经验已在其中固化）。
> 数据来源：对当前代码库的审计（非产品需求方录入），请按实际排期调整。
> **基准**：main 分支 2026-10-14（**不在此逐批枚举已完成项**——那会随每次提交过期，历史见 `git log`）。

图例：`需业务澄清` 未澄清前不要动手 · `需外部条件` 等基础设施/凭据 · `可直接开工` 纯工程项

> 分组依据是**阻塞条件**（而不是"优先级"）：标着"可直接开工"却全是阻塞项，会让人排错期。
> **例外**：「四域扩展」整块都**没有阻塞**（评估已定，见 [docs/05](docs/05-四域扩展可行性评估.md)），
> 故其内部按**先后**标注 —— 「待实施」→「按需」，不做优先级排序。
> 说明：**发票「查验」仅用于登记核对（把发票信息录入后标记为已查验），不做验真、不接第三方查验服务**，
> 故此项已按业务澄清从待办中移除。

## 需业务澄清（澄清前不要动手）

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
- **`/contracts` 旧合同编辑页去留**：该页（676 行，含四种条款选择）仅能通过旧 URL 进入，新菜单无对应入口
  （起草/查询分别由 `/contract/draft`、`/contract/query` 承担）。需确认是合并到 `/contract/draft`
  还是补回菜单；**确认前不要删**。
- **公告与采购文件的「采购时间」同名各存**：两页各有独立可编辑字段（同义、分别落库）。已登记进
  `SHARED_ACROSS_MODULES` 白名单并注明，待确认是否需要统一来源。
- **`SettlementLedger` 与结算单是否要强关联**：目前只靠 `contractId + settleMonth` 聚合
  （[docs/07](docs/07-工作域信息关联审计.md) §4 已声明「不强关联」）。若业务需要「一结算单对多台账行」，
  再补 `settlementId` FK。
- **响应体按角色打码（字段级展示脱敏）**：打码工具已具备（`common/utils/mask.ts` 的
  `maskField()/maskByKey()/slimSecrets()`），**日志侧已强制脱敏**；缺的是「**哪些角色看不到哪些字段**」
  这张映射表——没有它就只能靠猜，容易把业务要看的字段打掉。澄清后仿 `common/pick-fields.ts`
  在序列化处接入（行级 DataScope 视诉求，见 [docs/05](docs/05-四域扩展可行性评估.md) §9）。
- **资金费用与结算 / 付款的关联口径**：`FactoringCost`（融资贴息）与 `OverdueInterest`（逾期利息）
  目前只挂 `contractId` + `settlementMonth`（**月份是文本**），与具体结算单、付款记录**没有外键**
  ——[docs/07](docs/07-工作域信息关联审计.md) §4 #6 的遗留项，P1 批次未处置。
  要确认的是：**是否需要"这笔贴息/利息归属哪张结算单、哪笔付款"**；不需要则明确写死"按合同汇总"。
- **收领单 ↔ 结算 / 付款 / 发票 的显式关联**：三者的关系目前只经 `contractId` / `projectId` **间接**表达
  （[docs/07](docs/07-工作域信息关联审计.md) §4 #7）。若要回答"这笔结算对应哪些收领单"，需补 FK
  或关联表；**若确认不需要，也要把"只按合同聚合"写死**，别停在"关联不清晰"的状态里。
- **行级数据权限（DataScope）**：现有维度只有**项目**，无部门模型；可复用 `ProjectMember.roleCode`
  与 `createdBy` 做 `ALL / PROJECT / SELF` 三级（[docs/05](docs/05-四域扩展可行性评估.md) §9）。
  **触发条件**：出现"同项目内不同人可见范围不同"；落点建议仿 `pick-fields.ts` 加集中助手 `withDataScope(where, user)`。
- **供应商门户 / 外部账号体系**：`User` 无 `userType` / `supplierId`、无注册端点（全仓 0 命中，
  [docs/05](docs/05-四域扩展可行性评估.md) §11 结论是"放最后"）。**前置条件**：必须先有**强制**的数据范围——
  现状隔离靠约定，供应商一旦看到竞对报价就是商业事故。未澄清前不动。

> **关联依赖**：**清单项级结算明细（`SettlementItem`）** 与「结算量 ≤ 已确认量」的**量级校验**依赖上面的
> 「变更口径」澄清——否则会与补充协议口径打架（这也是 [docs/09](docs/09-重构方案评估与采纳建议.md) §4 缺口 E）。
> 澄清后再立项；在此之前，现场确认的闸门只作用到金额与"已确认量"提示层面。

## 需外部条件（基础设施 / 凭据 / 他人配合就绪即可做）

- **上传目录替换为对象存储**：落盘写入点原有 **3 处**（`file.controller.ts` 的 multer、`contract.service.sign()`
  的签章件、`import-task.service` 的导入错误报告），已统一收敛到 `common/services/storage.service.ts`
  （`StorageLike` + 本地实现；目录/命名/越权校验/URL 都收在这一层）。
  剩下的工作：实现 `S3StorageService`（MinIO/S3）、在 `common.module.ts` 换 provider 绑定，
  并把 `main.ts` 的静态服务 `useStaticAssets` 改为代理或 302 重定向；
  **阻塞原因**：无对象存储实例可供验收（写出来的 S3 分支无法真打）；顺带可加哈希校验与版本管理。
- **通知通道适配器**（企微/钉钉机器人 Webhook）：现状只有站内信
  （`notification.service.ts` 注释即写「邮件/短信/企微/钉钉接口预留」），`send()` 只做 DB insert。
  **阻塞原因**：需要机器人凭据与出网策略，且要业务定「哪些事件发到群里」。
  **同一份应用凭据下的姊妹项**：企微/钉钉**免登 SSO**（OAuth → 映射现有 `User` → 签发现有 JWT，
  **不新建平行账号体系**，见 [docs/05](docs/05-四域扩展可行性评估.md) §13 ②）——凭据就绪即可一并做，故不单列。
- **多副本部署前的三项必办**（[docs/05](docs/05-四域扩展可行性评估.md) §4）：① 文件本地磁盘
  （已由上面的"对象存储"条目覆盖）② **进程内缓存不一致**——`DictService.cache` 24h TTL、
  `refreshCache()` 只清本实例，A 改字典 B 最长 24h 才可见（`SysParamService` 同理）
  ③ **编号竞态**——`contract.service.nextCode()` 读 `max(yearSeq)` 再 +1，两副本会取到同号（被唯一约束挡住报错）。
  **阻塞原因**：单实例下这三条都无影响，**只在确定要上多副本时才值得做**；届时前置还有共享 PG 与共享存储。
- **定期备份与恢复演练**：README 与 docs **没有任何备份/恢复步骤**（`pg_dump` / `pg_restore` 0 命中），
  而 [docs/05](docs/05-四域扩展可行性评估.md) §2 的选型表自己就写着"DB 主从/备份：按需，**先落实定期备份**"。
  交付物：一份可执行步骤（compose 环境下 `pg_dump` → 留存 → `pg_restore` 到临时库）+ **本地实测一次恢复**
  （只写文档不演练等于没做）。**阻塞原因**：NAS 上的落地位置与保留策略待定（可在本地先做通）。
- **确认 CI 新 workflow 的首跑结果**：2026-10-14 改过 `.github/workflows/build.yml`（`test` job 新增
  postgres service、建影子库、`prisma migrate diff --exit-code` 门禁与 `npm run test:int`），
  但**本机无 `gh` CLI**、也无法本地解析 YAML 真跑一遍，只逐条验过里面的命令。需在 GitHub Actions 上
  看该 job 是否绿（步骤序：prisma generate → 建 `cms_shadow` → migrate diff → `npm test` →
  `npm run test:int` → server/web build）。**确认后删本条**。

## 可直接开工（工程项，按性价比排序）

- **变量面板标注「所属体系」**：采购模板变量与合同模板变量是**两套互不相通的实现**（同一个
  `{{项目名称}}` 在采购文档与合同正文里由**不同代码**替换、规则不同，见
  [docs/06](docs/06-变量体系梳理与歧义清单.md) §5 结构性歧义），但「插入变量」面板是**同一个通用壳**
  （`RichTextEditor.tsx` 的 Modal，由调用方传组：合同侧传 `Clauses.VARIABLE_GROUPS`、
  采购侧传 `getProcurementVariableGroups()`），**不标体系** → 在合同正文里插了采购体系的变量会**静默不替换**。
  做法：面板里按体系标注（组名前缀或一行说明），零风险、不动取值逻辑。
- **解除 `.mts` 单测的「相对导入」限制**（低优先，**先评估再动手**）：`.spec.mts` 由 Node 原生擦除类型
  加载，而 ESM 不做扩展名推断，故被测模块**不得有相对运行时 `import`**——`server/src/constants/procurementFlow.ts`
  为能被 spec 加载，刻意不 import `./statuses`，改成裸字面量 + 靠漂移锁兜底（见该文件内的解释注释与
  [AGENTS.md](AGENTS.md) §5）。解除需 TS ≥5.7（现 `^5.3.3`）并开 `allowImportingTsExtensions` /
  `rewriteRelativeImportExtensions`。**代价**：TS 升级会牵动 `nest build` 与 Prisma 生成物，须整体回归。

## 四域扩展（评估已定，待实施）

> 依据 [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md)。**招标域已实施（见上方"已定决策"），
> 下面各条为待排期任务，尚未实施。**

### 已定决策（2026-10-13）

- **招标域 = 设计 A**：招标作为**采购方式**并入现有采购工作流（与 `procurement_source` 字典语义一致），
  仅新增 `ProcurementBidder` + `ProcurementEvaluation` 两张结构化表，其余复用。
  → ✅ **已实施**（2026-10-19，迁移 `20261019000000_tender_bidder_and_evaluation`；
  双写/定标/存量回填的约定见 [AGENTS.md](AGENTS.md) §4「招标域」）。
- **进出场 = 只做物资**：复用 `AssetLedger` / `DailyReport` / `ReceiptOrder`，**不建表**、不做人员/车辆。
- **技术栈 = 沿用现有**；不引入微服务 / API 网关 / Redis / MQ / MongoDB / Flowable / Seata / 电子签章 / 低代码平台。

### 待实施 · 先设计后开发

- **单据关系设计（先做）**：采购任务 → 合同 → 采购订单 → 收货 → 对账 → 结算；明确与现有收领单/结算的复用边界。
- **采购下游**：`PurchaseOrder`(+Item) → 到货验收（**复用收领单**，加 `purchaseOrderId`）→ `Reconciliation`。
- **合同增强**：履约派生进度（零表）→（按需）`ContractFulfillment` → 归档锁定。

> 注：四域扩展的「采购下游」与已完成的「采购清单 → 合同清单衔接」是同一段链路的两端——
> 衔接已做（无新表），后续再做订单/对账（要新表）。

### 待实施 · 按需

- 移动刚需页 H5 精简版（全站响应式已完成，见 [docs/08](docs/08-全局响应式改造方案.md) §0.1）。
- 可选：半结构化字段改 PG `jsonb`、招标立项前置状态、`DailyReport.exitDate`。

## 本文件的维护方式

1. **完成即删除**：任务做完直接从本文件删条目，不留 `[x]`、不追加"最近完成"章节。
2. **新增任务**：只写「未完成、可执行」的事项，附证据（文件/接口/命令）与**阻塞原因**；
   按阻塞条件分流到三档之一：`需业务澄清` / `需外部条件` / `可直接开工`。
3. **需要长期记住的约定与坑**：**不要写在本文件**——写进 [AGENTS.md](AGENTS.md)（改动前必读的硬约定）
   或 [docs/development.md](docs/development.md)（做法与命令）；本仓库已不再保留 `.workbuddy/memory/`
   之类的历史记忆目录（2026-10-14 清理，内容含已废弃的 SQLite/双 schema 指引）。
   同理，**本文件不写「现为 N 个 spec / N 项断言」这类会过期的数字**：活文档的计数由
   `server/test/docStats.spec.mts` 锁，历史报告标「当时快照」即可（见 [AGENTS.md](AGENTS.md) §8 末尾）。
4. 与 [AGENTS.md](AGENTS.md) 的「验收铁律」配合使用：改完必须过构建 + 单测 + 真打请求。
