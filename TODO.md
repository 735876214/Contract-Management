# TODO.md · 任务、优先级与开发进度

> 数据来源：对当前代码库（main @ `0755e7c`，2026-09-17）的审计，**非**产品需求方录入。
> 任务为「可观测的缺口与待办」，请按实际排期调整。完成后请勾选并同步本文档。

图例：`P0` 阻塞/高优先 · `P1` 应尽快 · `P2` 改进项 · `P3` 可选
状态：`[ ]` 待办 · `[~]` 进行中 · `[x]` 已完成

## 一、当前状态总览

| 领域 | 进度 | 说明 |
|---|---|---|
| 后端业务模块 | ✅ 完成 | 22 个模块、50 个 model、全量 CRUD + 导入导出 |
| 采购工作流 | ✅ 完成 | 三种采购类型全阶段链 + 三处驳回 + 多合同生成 |
| 前端页面 | ✅ 完成 | 全部页面可用，采购六模块标准列表化 |
| 数据库 | ✅ 完成 | 已收敛 PostgreSQL 单 schema + 折叠基线迁移 |
| 部署 | ✅ 完成 | 单容器镜像 + CI 自动构建 + NAS 部署脚本 |
| 单测 | 🟡 部分 | 后端 3 个 spec（采购流/驳回守卫/前后端一致性）；**前端无测试** |
| 文档 | ✅ 完成 | AGENTS/DESIGN/TODO + docs/ 五份规范文档；docs/01-04 已按实现校准（docs/03 待重写） |

## 二、待办池

### P0 · 正确性与一致性 ✅（2026-10-13 完成）

- [x] **修正过时文档**：已按 `schema.prisma` 重写 `docs/01-需求确认摘要.md`（模块清单 22 个、
  移除部门管理、补充采购工作流）与 `docs/02-数据库ER设计.md`（50 个 model、移除 Dept/
  PaymentPlan/PaymentApply、补齐采购/收领单/资金费用/资产等域）。
- [x] **清理过时项目记忆**：已重写 `.workbuddy/memory/MEMORY.md`，删除「Prisma 双 schema（sqlite）」
  「资审报告阶段」「chinese-amount.ts 未纳入版本控制」「server/src 11 个文件停留旧版本」等失效内容，
  改为当前 PostgreSQL 单 schema 事实。
- [x] **`docs/04-Docker镜像构建与优化.md` 补写**：已新建（原引用在 `.workbuddy/memory/MEMORY.md`，
  **并非 README**——此前描述有误）；同时修正 `deploy/single/Dockerfile.single` 中两处
  「启动时 db push」注释（实际为 `migrate deploy`）。

**P0 顺带发现的遗留（未处理，见下方 P1/P2）**：`docs/03-API接口清单.md` 仍列有已移除的
`/system/depts`（部门）与 `/payments/plans`、`/payments/applies`（付款计划/申请），且缺少
采购/收领单/资金费用等新接口，需按当前路由重写。

### P1 · 体验与健壮性

- [ ] **重写 `docs/03-API接口清单.md`**：仍含已移除的 `/system/depts`、`/payments/plans`、
  `/payments/applies`，且缺采购/收领单/资金费用/资产等新接口，需按当前 controller 路由重出。
- [ ] **修复变量体系歧义**（清单见 [docs/06](docs/06-变量体系梳理与歧义清单.md)）：优先
  ① `预计采购金额` 单位不一致（采前会=万元 / 成交报告=元，**可能差 10000 倍**）；
  ② 同概念不同名（`技术质量要求` vs `技术质量标准` 等）；③ `INITIATE` 变量定义了却永不替换。
  另建议加"变量定义 ↔ 取值实现"一致性测试，防回归。
- [ ] **修复工作域关联中断**（清单见 [docs/07](docs/07-工作域信息关联审计.md)）：优先
  ① 删除死字段 `PaymentRecord.applyId`（指向已移除的 `PaymentApply`）；
  ② 采购任务↔合同去重（保留 `Contract.taskId`）；③ 补关键 FK（`Contract.templateId`、4 个 `*ClauseId`、
  `ProcurementTotalItem.materialBaseId` 等）；④ 收领单→日报改用 `receiptOrderId` 替代 `receiptNo` 文本匹配；
  ⑤ 明确"是否做核销"。另建议加"schema 悬空引用"校验测试 + 白名单。
- [ ] **全局响应式改造**（方案见 [docs/08](docs/08-全局响应式改造方案.md)）：现状为"响应式栅格 + 非响应式布局"；
  建议**先做阶段 1（基建+布局）**——新增 `useResponsive` + 改造 `BasicLayout`/`Sider`（窄屏 Drawer）+ `index.css`；
  再做表格分级（≤md 冻结列）、65 个 Modal 与 36 处固定 `Col` 清理。
- [ ] **前端无任何自动化测试**：新增逻辑（尤其采购变量计算、金额换算、阶段链）建议补最小单测。
  注：阶段链一致性已有 `server/test/frontendChainParity.spec.mts` 锁定，可作为范式。
- [ ] **路由级权限未强制**：`web/src/router.tsx` 无按权限拦截路由，权限仅作用于侧边菜单过滤。
  直接输入 URL 可进入无权页面（后端仍会 403，但用户体验差）。建议加 `RequirePermission` 包裹。
- [ ] **无路由懒加载**：所有页面静态 import，首屏体积偏大（已用 `manualChunks` 分 react/antd/echarts 缓解）。
  建议对低频页面改 `React.lazy` + `Suspense`。
- [ ] **发票查验为预留**：`POST /invoices/:id/verify` 未接入第三方查验接口（`invoice-recognizer.ts` 仅做二维码识别）。
  如需验收需在需求侧确认服务商。
- [ ] **通知渠道预留**：`NotificationService` 仅实现站内信，邮件/短信/企微/钉钉为接口预留。

### P2 · 代码整洁

- [ ] **删除未引用代码**：
  - `web/src/pages/Procurement/Placeholder.tsx`（`ProcurementPlaceholder`）无任何引用；
  - `web/src/hooks/useTablePage.ts` 是对 `useTable` 的薄封装，全库无引用（死代码）。
- [ ] **新旧路由收敛**：`web/src/router.tsx` 同时保留旧扁平路径与新规范路径，指向同一组件。
  确认无外部书签/深链依赖后，可移除旧路径。
- [ ] **`finance` / `dict` 项目隔离例外补文档**：这两个模块不按 `projectId` 过滤，
  建议在 `docs/architecture.md` 之外，在模块 README 或代码注释中显式说明，避免误加过滤。

### P3 · 可选增强

- [ ] 台账/看板的列配置持久化已具备（`sys_param: ledger.columns.config`），可扩展到更多列表页。
- [ ] 为 CI 增加「构建产物 + 单测」门禁（当前 CI 只构建镜像，未跑 `pnpm test`）。
- [ ] 上传目录可替换为对象存储（`FileController` 是唯一写入点）。

## 三、最近完成（时间线）

| 日期 | 内容 |
|---|---|
| 2026-10-13 | **文档体系梳理**：新增 AGENTS/DESIGN/TODO + docs/{project-overview,architecture,user-guide,development,component-api}；校准 docs/01/02、重写 `.workbuddy/memory/MEMORY.md`、补写 docs/04（P0 完成） |
| 2026-10-13 | **全局响应式改造方案**（[docs/08](docs/08-全局响应式改造方案.md)）：实测现状（155 栅格断点 / 1 媒体查询 / 0 断点监听）并制定分层改造方案 |
| 2026-10-13 | **工作域信息关联审计**（[docs/07](docs/07-工作域信息关联审计.md)）：定位 27 处悬空外键、8 类弱关联、核销缺失 |
| 2026-10-13 | **变量体系梳理**（[docs/06](docs/06-变量体系梳理与歧义清单.md)）：梳理采购/合同两套占位符体系，列出 8 项歧义/缺陷 |
| 2026-10-13 | **四域扩展可行性评估**（[docs/05](docs/05-四域扩展可行性评估.md)）：结论为"在现有系统增量扩展"；定两项决策——招标域=**设计 A**、进出场=**只做物资** |
| 2026-09-17 | 采购工作流扩展与合同体系重构；**数据库收敛为 PostgreSQL + 折叠基线迁移**；本地调试 compose + 端到端验收脚本 |
| 2026-09-17 | 单容器构建/部署可靠性修复 |
| 2026-09-14 | 移除双容器方案，仅保留单容器部署；CI 构建提速（amd64 单架构 + 并行 + GHA 缓存） |
| 2026-09-13 | 采购发起三步向导、三标准贯通、关联合同自动生成；移除部门管理；新增「物资产地」字段 |

## 四、维护约定

- 新增采购阶段子模块需同步改**六处**：`schema.prisma`（含两侧反引用）→ 迁移 SQL →
  service（`xxx()/saveXxx()/serializeXxx()/publish()` 校验）→ controller（GET+PUT）→
  前端 `api/modules.ts` + `constants/procurementVariables.ts` → `utils/<模块>.ts` + 页面。
- 采购阶段链改动：后端 `constants/procurementFlow.ts` 与前端 `constants/procurementWorkflow.ts`
  **必须同步**，跑 `cd server && pnpm test` 验证一致性锁通过。
- 本文件与 [AGENTS.md](AGENTS.md) 的「验收铁律」配合使用；完成一项即勾选并在 §三 追加时间线。

## 五、四域扩展（评估已定，待实施）

> 依据 [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md)。**以下均为待排期任务，尚未实施。**

**已定决策（2026-10-13）**

- ✅ **招标域 = 设计 A**：招标作为**采购方式**并入现有采购工作流（与 `procurement_source` 字典语义一致），
  仅新增 `ProcurementBidder` + `ProcurementEvaluation` 两张结构化表，其余复用。
- ✅ **进出场 = 只做物资**：复用 `AssetLedger` / `DailyReport` / `ReceiptOrder`，**不建表**、不做人员/车辆。
- ✅ **技术栈 = 沿用现有**（NestJS + Prisma/PostgreSQL + React/AntD），**不换栈**；
  不引入微服务 / API 网关 / Redis / MQ / MongoDB / Flowable / Seata / 电子签章 / 低代码平台。

**待实施（P1 级 — 先设计后开发）**

- [ ] **单据关系设计**（先做）：采购任务 → 合同 → 采购订单 → 收货 → 对账 → 结算；明确与现有收领单/结算的复用边界。
- [ ] **招标域**：`ProcurementBidder` + `ProcurementEvaluation` + 页面 + 定标→合同衔接
      （复用 `generateLinkedContract` 写法）。
- [ ] **采购下游**：`PurchaseOrder`(+Item) → 到货验收（**复用收领单**，加 `purchaseOrderId`）→ `Reconciliation`。
- [ ] **合同增强**：履约派生进度（零表）→（按需）`ContractFulfillment` → 归档锁定。

**待实施（P2/P3 — 按需）**

- [ ] 通知通道适配器（站内信 + 企微/钉钉机器人 Webhook）。
- [ ] 前端框架级响应式（`BasicLayout` / `ModuleListPage`）+ 移动刚需页 H5 精简版。
- [ ] 日志脱敏白名单 + 展示脱敏 `maskField()`（行级 DataScope 视诉求）。
- [ ] `ImportTask` 崩溃恢复（`lockedAt` 心跳）+ 幂等键；需要真队列时上 **pg-boss**。
- [ ] 可选：对象存储（MinIO 替换本地磁盘）、半结构化字段改 PG `jsonb`、
      招标立项前置状态、`DailyReport.exitDate`。
