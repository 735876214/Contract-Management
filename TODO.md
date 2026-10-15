# TODO.md · 剩余任务

> **本文件只列「未完成」任务**：完成一项就**直接删除条目**（不用 `[x]` 勾选、不写"已完成"段落，
> 否则文件只增不减）；历史以 `git log` / PR 为准。
> 改动前必读的约定与踩过的坑见 [CLAUDE.md](CLAUDE.md)（**唯一事实源**；历史经验已在其中固化）。
> 数据来源：对当前代码库的审计（非产品需求方录入），请按实际排期调整。
> **基准**：main 分支 2026-10-14（**不在此逐批枚举已完成项**——那会随每次提交过期，历史见 `git log`）。

图例：`需业务澄清` 未澄清前不要动手 · `需外部条件` 等基础设施/凭据 · `可直接开工` 纯工程项

> 分组依据是**阻塞条件**（而不是"优先级"）：标着"可直接开工"却全是阻塞项，会让人排错期。
> **例外**：「四域扩展」整块都**没有阻塞**（评估已定，见 [docs/05](docs/05-四域扩展可行性评估.md)），
> 故其内部按**先后**标注 —— 「待实施」→「按需」，不做优先级排序。
> 说明：**发票「查验」仅用于登记核对（把发票信息录入后标记为已查验），不做验真、不接第三方查验服务**，
> 故此项已按业务澄清从待办中移除。

## 需业务澄清（澄清前不要动手）

> 按错方向做会**造出两套口径或推翻既有决策**，故先澄清再排期。

> **2026-10-16 已清空四条**：[docs/09](docs/09-重构方案评估与采纳建议.md) §7 的四条（付款三级模型 /
> 合同正文导出快照 / 变更口径 / 审批流）已由业务方答复并**落地**（记录见该文 §7 与 §9），故从本清单删除。
> **连带解锁**：变更口径已定（结构化 + 合同当前金额 = 主合同 + Σ 补充协议增量）后，
> **清单项级结算明细（docs/09 §2.2 E）**不再被它阻塞——已列为「可直接开工」项。

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

- **清单项级结算明细（docs/09 §2.2 E）+ 量级校验**（**口径已解锁**，2026-10-16）：现状
  `Settlement` 只有总额、`SettlementLedger` 只有按月汇总、**都没有 `materialBaseId`**，所以做不到
  "某清单项结算了多少、还剩多少可结"，也做不了"结算量 ≤ 已确认量"的量级校验。
  现在口径齐了：基线取**合同链的 `ContractMaterial`**（与 `common/utils/contract-chain.ts` 同一形状，
  补充协议自己就带清单行），可结量 = 链上清单量 + 已生效变更增量。
  ⚠️ 两处必须一起处理，否则会添第三套口径：① `SettlementLedger` 是**派生**表
  （由结算/发票/保理/逾期按 `contractId + 月` 合成，见 `settlement.service` 的 `computeLedgerAutoFields`），
  ② 现场确认闸门（`settlement.require_confirmed`）目前只作用到金额与提示层。
  落地点：新表 `SettlementItem`（`settlementId + materialBaseId + qty + amount`）+ 服务端按已确认量校验
  + 结算单界面行级录入 + 台账/导出接线。规模中等，建议先出一份设计再动手。

- **响应式收尾：弹窗内的 `Descriptions` 列数仍是固定值**（外层是弹窗、判定依据该是容器宽度）：
  `TaskViewModal` 与 `ModuleDetailCard` 两处已按容器驱动，其余弹窗里的
  `Descriptions column={n}`（如合同详情弹窗）没接 `useContainerWidth()`，窄弹窗里会偏挤。
  无阻塞；做法照 `ModuleDetailCard` 那三行（`isNarrow ? 1 : isWide ? 3 : 2`）即可。
  注：V2 的阶段 0–5 已全部落地（实施记录见该文 §0.2，容器级验收见 §4），本条只是收尾。

- **解除 `.mts` 单测的「相对导入」限制**（低优先，**已评估完，按需再做**）：2026-10-15 专项调查后
  更正了本条原先的措辞——**TS 版本不是障碍**：锁文件里 typescript 已是 5.9.3，
  `allowImportingTsExtensions` 与 `rewriteRelativeImportExtensions` 都可用
  （原先写的「现 ^5.3.3」只看了声明下限）。
  真正的限制是 **Node 类型擦除不支持装饰器与 JSX**：服务与 `.tsx` 组件**永远**进不了 `.mts`，
  解除扩展名限制的收益**仅限纯逻辑模块**（如让 `procurementFlow.ts` 直接 import `./statuses` 而不是写裸字面量）。
  **代价**：改 `tsconfig`（影响 `nest build` 与 ts-node 侧的 `.ts` spec/seed/`test:int`，需逐个验证），
  并在相关相对 import 上补 `.ts` 扩展名。已落地的兜底：`test/mtsConstraints.spec.mts` 把「被 `.mts`
  引用的模块不得新增无扩展名相对 import」钉死，所以**不做也不会踩雷**。

## 四域扩展（评估已定，待实施）

> 依据 [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md)。**招标域已实施（见上方"已定决策"），
> 下面各条为待排期任务，尚未实施。**

### 已定决策（2026-10-13）

- **招标域 = 设计 A**：招标作为**采购方式**并入现有采购工作流（与 `procurement_source` 字典语义一致），
  仅新增 `ProcurementBidder` + `ProcurementEvaluation` 两张结构化表，其余复用。
  → ✅ **已实施**（2026-10-19，迁移 `20261019000000_tender_bidder_and_evaluation`；
  双写/定标/存量回填的约定见 [CLAUDE.md](CLAUDE.md) §4「招标域」）。
- **进出场 = 只做物资**：复用 `AssetLedger` / `DailyReport` / `ReceiptOrder`，**不建表**、不做人员/车辆。
- **技术栈 = 沿用现有**；不引入微服务 / API 网关 / Redis / MQ / MongoDB / Flowable / Seata / 电子签章 / 低代码平台。

### 待实施 · 先设计后开发

- **单据关系设计（先做）**：采购任务 → 合同 → 采购订单 → 收货 → 对账 → 结算；明确与现有收领单/结算的复用边界。
- **采购下游**：`PurchaseOrder`(+Item) → 到货验收（**复用收领单**，加 `purchaseOrderId`）→ `Reconciliation`。
- **合同增强**：履约派生进度（零表）→（按需）`ContractFulfillment` → 归档锁定。

> 注：四域扩展的「采购下游」与已完成的「采购清单 → 合同清单衔接」是同一段链路的两端——
> 衔接已做（无新表），后续再做订单/对账（要新表）。

### 待实施 · 按需

- 移动刚需页 H5 精简版（响应式 V1 视口层 + V2 容器层均已完成，规则见 [DESIGN.md](DESIGN.md) §10）。
- 可选：半结构化字段改 PG `jsonb`、招标立项前置状态、`DailyReport.exitDate`。

## 本文件的维护方式

1. **完成即删除**：任务做完直接从本文件删条目，不留 `[x]`、不追加"最近完成"章节。
2. **新增任务**：只写「未完成、可执行」的事项，附证据（文件/接口/命令）与**阻塞原因**；
   按阻塞条件分流到三档之一：`需业务澄清` / `需外部条件` / `可直接开工`。
3. **需要长期记住的约定与坑**：**不要写在本文件**——写进 [CLAUDE.md](CLAUDE.md)（改动前必读的硬约定）
   或 [docs/development.md](docs/development.md)（做法与命令）；本仓库已不再保留 `.workbuddy/memory/`
   之类的历史记忆目录（2026-10-14 清理，内容含已废弃的 SQLite/双 schema 指引）。
   同理，**本文件不写「现为 N 个 spec / N 项断言」这类会过期的数字**：活文档的计数由
   `server/test/docStats.spec.mts` 锁，历史报告标「当时快照」即可（见 [CLAUDE.md](CLAUDE.md) §8 末尾）。
4. 与 [CLAUDE.md](CLAUDE.md) 的「验收铁律」配合使用：改完必须过构建 + 单测 + 真打请求。
