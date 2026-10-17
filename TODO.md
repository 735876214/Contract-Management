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

> **2026-10-16 已清空两批**：
> ① 付款三级模型 / 合同正文导出快照 / 变更口径 / 审批流 —— 业务已答复并**落地**，
> 见 [CLAUDE.md](CLAUDE.md) §1「已定的产品口径」；并**连带解锁**了「清单项级结算明细」（已列「可直接开工」）。
> ② 原「工作域信息关联审计」里最后三条待澄清（台账↔结算单 / 资金费用↔结算 / 收领单↔结算）
> —— 业务**全部翻案**（都要强关联），并追加合同付款比例节点、总结算单、单据模板、付款手续、付款超比例预警；
> 「结算域重构与新增单据」批次（8 阶段）**已全部落地**（见下方条目的 ✅ 标）。

- **`/contracts` 旧合同编辑页去留**：该页（676 行，含四种条款选择）仅能通过旧 URL 进入，新菜单无对应入口
  （起草/查询分别由 `/contract/draft`、`/contract/query` 承担）。需确认是合并到 `/contract/draft`
  还是补回菜单；**确认前不要删**。

- **「新增进编辑器页签」两处有意保留弹窗（业务 2026-10-17 口径：新增必须进编辑界面）**：
  ① 基础配置类 6 个模块（字典 / 用户角色 / 合同模板 / 条款 / 单据模板 / 采购模板）**保留弹窗**
  （低频简单表单，业务确认保留；若后续要统一再改页签）；② 「新增补充协议」（ContractQuery 的
  SupplementDraft 向导弹窗 + 合同详情里的简易补充协议弹窗）是**向导型动作**（选类型→生成草稿→发布），
  暂保留弹窗，如业务要求统一改页签再动。

- **公告与采购文件的「采购时间」同名各存**：两页各有独立可编辑字段（同义、分别落库）。已登记进
  `SHARED_ACROSS_MODULES` 白名单并注明，待确认是否需要统一来源。

- **响应体按角色打码（字段级展示脱敏）**：打码工具已具备（`common/utils/mask.ts` 的
  `maskField()/maskByKey()/slimSecrets()`），**日志侧已强制脱敏**；缺的是「**哪些角色看不到哪些字段**」
  这张映射表——没有它就只能靠猜，容易把业务要看的字段打掉。澄清后仿 `common/pick-fields.ts`
  在序列化处接入（行级 DataScope 视诉求，见 [docs/05](docs/05-四域扩展可行性评估.md) §9）。

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


- **结算域重构与新增单据（业务 2026-10-16 答复的批次，分批实施）** —— 共 8 个阶段，**每阶段独立可验收**：
  - ✅ **P1 台账 ↔ 结算单 1:1 + 台账派生列只读**（已实施：迁移 `20261022000000_settlement_ledger_link`，
    接上了此前**无调用点**的 `syncLedgerByContract()`；口径见 [.claude/rules/backend-conventions.md](.claude/rules/backend-conventions.md) 「台账」一节）。
  - ✅ **P2 仅费用行 + 发票/收领单挂结算单**（已实施：迁移 `20261023000000_settlement_invoice_receipt_link`
    加 `Invoice.settlementId` / `ReceiptOrder.settlementId`（SetNull）；「仅费用行」由 `refreshLedger()` 的
    combos 保住；台账「本月开票额」改为**按 `settlementId` 精确归集**、未关联才退回按「合同 + 月」）。
  - ✅ **P3 月度结算期 + 手动生成本期结算**（已实施：`Project.settlementStartDate`；纯函数
    `common/utils/settlement-period.ts`；`POST /settlements/generate` + `GET /settlements/generate/preview`；
    结算单页顶部未生成提示 + 「生成本期结算」按钮。**不引入调度器**，故为手动触发）。
    ⚠️ 归属判据是**结算期**而不是自然月（起始日 ≠ 1 时期会跨月），详见
    [.claude/rules/backend-conventions.md](.claude/rules/backend-conventions.md)「结算期与自动生成」。
  - ✅ **P4 合同付款比例与分期**（已实施：迁移 `20261024000000_settlement_pay_ratio` 加
    `ContractExt.settlementPayRatio`；`paymentMode` 扩 `M65_1` / `M65_3` 两种月度安排（存量 `100`/`3382` 不动），
    定义与文案在零依赖 `common/utils/pay-ratio.ts`，前端下拉是它的镜像；`currentPayRatio` 改为**服务端派生**
    （已完已结 = 100%，否则按安排的月度比例，自定义取手填；推不出保持原值））。
  - ✅ **P5 工作台「超付款比例」预警**（已实施：`evaluatePaymentRatioAlert()` 纯函数 + 工作台
    `paymentRatioAlerts` 与「付款超比例预警」卡片；**单级**、比例未填/为 0 不报、"恰好等于上限"不算超）。
  - ✅ **P6 付款手续编制**（已实施：迁移 `20261025000000_payment_procedure` 建 `PaymentProcedure`；
    后端 `payment-procedure` 模块 + 菜单「付款手续」+ 页面 `/settlement/payment-procedure`。
    口径取舍：**合同必填**（开累本来就是合同链口径），开累结算/开累付款/未付款三值由服务端
    **按链口径取数并快照**、前端只读展示 —— 单据要的是"编制当时的口径"，事后补录付款不改写已出单据）。
    ⬜ 付款单 **Word 导出**与 P8 的「单据模板」一起接（模板模块先落地）。
  - ✅ **P7 总结算单模块**（已实施：迁移 `20261026000000_final_settlement` 建 `FinalSettlement` +
    `FinalSettlementItem`；页面 `/settlement/final-settlement`。**生成**抓该合同全部非草稿月度结算落成
    明细快照（一个合同只允许一张）；**上传附件 → 已结算 → 合同 `execStatus = DONE_SETTLED`
    且付款比例切 100%**（走 P4 的 `syncPayRatio`）；**删除已结算单据会把合同状态与比例一并回退**，
    不留"没有单据支撑的已完已结"；可导出 Word（模板分类 `FINAL_SETTLEMENT`，明细走 `{{结算明细表}}`））。
  - ✅ **P8 单据模板模块**（已实施：基础信息管理 →「单据模板」页 `/base/doc-template`，五类
    —— 结算单/总结算单/保理单/逾期利息/付款单。存储**复用 `ContractTemplate` 表**、分类走**新字典**
    `doc_template_category`（不复用合同模板分类，否则合同模板的下拉里会冒出"付款单"）；
    **付款单已接 Word 生成路径**（付款手续行内「导出付款单」，变量取值见 `doc-template-vars.ts`）。
    其余四类本期只提供模板存放与编辑，生成随各自单据模块接 —— 变量面板也**只对付款单开放**，
    避免作者插了变量却不被替换）。顺手修：变量面板默认插入的是**单花括号** `{名}`，
    而渲染器只认 `{{名}}` —— 插了静默不替换，现已改双花括号并由 `docVariables.spec.mts` 锁住。

- **清单项级结算明细 + 量级校验**（**口径已解锁**，2026-10-16）：现状
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
