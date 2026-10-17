# CLAUDE.md · AI 进入本项目的必读信息

> 面向 AI 编码助手的项目入门。**动手前先读完本文件**，其余细节见文末索引。
> 本文件只写**现状**与**会踩的坑**；历史修复记录见 `git log`，不再搬到这里。

## 1. 这是什么

**企业合同管理系统（CMS）**：面向工程/采购型企业的合同全生命周期管理，覆盖
`项目 → 供应商/分包商 → 采购工作流 → 合同 → 日报/收领单 → 结算付款 → 发票 → 台账 → 还款协议` 主链路，
并配套模板、通知、看板与系统管理。

**已定的产品口径**（业务答复，别再重新提议）：

- **无多级流程引擎**：合同流转就是 `status`（草稿中 → 待签章 → 已签章）+ `/sign` + `/reject` 状态回退；
  不做可配置流程，不再使用"审批"这一说法。
- **付款只有单表台账** `PaymentRecord`（登记**已完成**的付款），**不做**「计划 / 申请 / 核销（三单匹配）」。
- **变更靠补充协议链表达并结构化**：**合同当前金额 = 主合同金额 + Σ 补充协议 `changeAmount`（带符号）**；
  工作台对超限出红/黄**预警**（只展示、不拦单据——拦不拦由 `*_over_amount_policy` 决定）。
- **合同正文导出取签订时快照**（`Contract.supplierSnapshot`，签章时冻结）。
- **结算按「月度结算期」组织**：期 = 起始日（`Project.settlementStartDate`）→ 下月同日的前一日；
  发票与收领单按结算期归属结算单；本期结算由**手动按钮**生成，**不引入调度器**。
  纯函数唯一来源 `common/utils/settlement-period.ts`——**别在各 service 自己拼 `getMonth`**。
- **付款安排决定付款比例**：`M65_1` / `M65_3` 二选一（合计 65%），总结算完成切 100%，存量 `100`/`3382` 保留；
  `ContractExt.currentPayRatio` 是**服务端派生列**（`contract.service.syncPayRatio`）——台账列、逾期引擎、
  工作台预警都读它，不要界面手填。付款**不与结算/发票关联**。
- **总结算单收口**：附件上传完成即「已结算」→ `execStatus = DONE_SETTLED` → 付款比例切 100%；
  删除已结算单据一并回退。单据模板接了 Word 生成路径的是**付款单与总结算单**。
- 不引入 Flowable / Redis / MQ / 物化视图 / DB 枚举（理由见 [docs/05](docs/05-四域扩展可行性评估.md) §2/§5）。

**技术栈**：前端 React 18 + TS + Vite 5 + AntD 5 + Zustand + ECharts；后端 NestJS 10 + Prisma 5 +
**PostgreSQL 16**（唯一数据库）；鉴权 JWT + RBAC（权限码 `module:action`）；npm 统一带 `--legacy-peer-deps`。

## 2. 目录地图

```
Contract-Management/
├── CLAUDE.md  DESIGN.md  TODO.md  README.md  docs/
├── server/              # NestJS 后端
│   ├── prisma/schema.prisma        # 全量数据模型（58 个 model）
│   ├── prisma/migrations/          # 折叠基线 20260901000000_init + 21 个增量迁移
│   │                               #   （p1_consistency / site_confirmation / scrub_log_secrets
│   │                               #    / import_task_recovery / canonicalize_template_placeholders
│   │                               #    / tender_bidder_and_evaluation / contract_change_and_snapshot
│   │                               #    / drop_contract_type_enum / settlement_ledger_link
│   │                               #    / settlement_invoice_receipt_link / settlement_pay_ratio
│   │                               #    / payment_procedure / final_settlement
│   │                               #    / procurement_task_clauses / labor_and_cost_modules
│   │                               #    / merge_subcontractor_into_labor / labor_receiving_summary
│   │                               #    / labor_summary_by_id / monthly_profit_loss
│   │                               #    / receipt_is_asset / drop_subcontract_receiving）
│   ├── prisma/seed.ts  src/seed.ts  src/seed-data.ts
│   ├── src/common/     # 通用层：统一响应/异常/装饰器/Excel/导入/日志/系统参数/存储
│   ├── src/constants/  # procurementFlow.ts（采购工作流单一事实源）、statuses.ts、workflowGuards.ts
│   ├── src/modules/    # 27 个业务模块
│   ├── test/           # node:test 纯函数单测（39 个 spec，无 DB；清单见 docs/development.md §5）
│   └── test-integration/ # DB 集成测试（6 个 spec，需 PostgreSQL：npm run test:int）
├── web/                 # React 前端（src/{api,components,constants,hooks,layouts,pages,store,utils}）
├── deploy/single/  docker-compose.yml  docker-compose.dev.yml  scripts/  .github/
```

## 3. 五条铁律（违反必踩坑）

1. **数据库只用 PostgreSQL**。改模型改 `server/prisma/schema.prisma` 并出迁移；**禁止 `prisma db push`**
   （CI 有静态与 diff 两道门禁）。加外键先在同一迁移内清洗数据（范例见
   `prisma/migrations/20261014000000_p1_consistency`）。
2. **接口统一返回** `{ code, data, message, timestamp }`，`code === 0` 为成功；
   错误码 1001 / 1401 / 1403 / 1500。前端 axios 已解包并统一弹错，页面里不要再重复提示。
3. **项目隔离靠约定，不是中间件**：service 在 `where` 里显式带 `projectId`。
   **新增业务表/查询必须自己带上过滤**。例外：`dict` 全局、`finance` 按 `contractId`、
   `supplier` 受 `supplier.share.scope` 控制。
4. **字典驱动 + code 单一事实源**：下拉/标签/颜色来自 `dict_type`/`dict_item`，业务表存字典编码字符串；
   核心状态码写常量（`SETTLEMENT_STATUS.DRAFT`，不裸写 `'DRAFT'`），单一事实源在
   `server/src/constants/statuses.ts` 与 `procurementFlow.ts`，由 `statusCodes.spec.mts` 双向锁死。
5. **供应商信息不冗余**：合同只存 `supplierId`；例外是签订时快照 `Contract.supplierSnapshot`
   （"历史合同再导出不被主数据改写"的留痕）。

## 4. 改动前必看（细则在 `.claude/rules/`，按需加载）

> ⚠️ **`.claude/rules/*.md` 不会自动加载**：命中下表场景时**先读对应文件再动手**。

| 改动场景 | 先读 | 该文件覆盖的坑 |
|---|---|---|
| 后端 service / 迁移 / 结算 / 台账 / 日志 | [backend-conventions.md](.claude/rules/backend-conventions.md) | 六处同步 · 外键清洗 · 乐观锁 · 写白名单 · 日志脱敏 · 主合同判定（**`list[0]` 不是主合同**）· 日报行是结算量唯一来源 · 金额上限（**无金额 = 无上限**）· 台账列宽是字符宽 · 存储单一入口 · 结算期归属 · 分包单位领用/月度盈亏口径 |
| 招标·投标·评标 / 采购变量 | [procurement-and-tender.md](.claude/rules/procurement-and-tender.md) | 导入**双写** · 定标 = 勾选候选人 · 生成合同只从结构化中标行取价 · 变量名必须带单位 · 三套变量体系 · 项目字段名两套 |
| 导入 / 模板与占位符 | [import-and-templates.md](.claude/rules/import-and-templates.md) | 两阶段「全成功或全失败」· 心跳回收 · 幂等去重（**命中后不得再 execute**）· 占位符只认 `{{}}` · **种子模板有两处** |
| 前端页面·组件·样式·路由 | [frontend-conventions.md](.claude/rules/frontend-conventions.md) | `perm()` 工厂 · 视觉只改 token 层 · **断点两层：外壳看视口 / 组件看容器** · 列显隐两条路 · 菜单权威在后端 · 多页签与编辑器页签 |
| 测试 / 改金额·状态·导入 | [testing.md](.claude/rules/testing.md) | 两套测试分工（改金额/状态/导入**必跑 `test:int`**）· `.mts` 三条硬约束 · 新增 spec 要同步 §5 清单与计数 |

## 5. 前端约定（速览）

- 新页面用 `perm('/路径', <Page/>)`；后端菜单配了 `permission` 就要在 `ROUTE_PERMISSIONS` 登记**同一权限码**。
- 视觉只改 token 层（`theme.ts`、`index.css` 的 `--cms-*`、`Sider/index.less`），**不写死色值**。
- **断点分两层**：页面外壳看**视口**（`useResponsive()`）；组件内部看**容器**
  （`.cq` + `@container`，规则在 `styles/containers.css`；CSS 表达不了才用 `useContainerWidth()`）。
  弹窗/抽屉正文本身就是容器。
- **表格必须声明 `scroll={{ x }}`**；次要列加 `col-secondary`。
- **多页签（keep-alive）**：页面按标签缓存不重挂载——复检挂 `useTabActivate`；
  **编辑器页签 = `?editor=new|<id>` 查询参数**（不新增路由），判断形态一律 `useEditorTab()`
  （**禁止 `useLocation()`**——列表与编辑器标签同时挂在 DOM 上）；跨标签刷新靠
  `useTabRefresh(列表路径)` + 编辑器 `closeEditor()`；无标签路由必须有兜底渲染（`BasicLayout`）。
  模式范例 `Payments.tsx`（最简）。
- 前端纯逻辑单测放 `server/test/*.spec.mts`（不引入 jest/vitest）。

## 6. 常用命令

```bash
docker compose -f docker-compose.dev.yml up     # 本地开发（前端 :5173 / 后端 :3000 / PG :15432）

# 验收（改完必做）
cd web    && npm run build     # = tsc --noEmit && vite build
cd server && npm run build     # = nest build
cd server && npm test          # node:test 纯函数单测（39 个 spec，无 DB）
cd server && npm run test:int  # DB 集成测试（6 个 spec，改金额/状态/导入必跑）
```

> **本机操作要点**（看退出码、`MSYS_NO_PATHCONV=1`、SSH 推送、Prisma 非交互生成迁移、
> Edge headless + CDP 真渲染）见 [docs/development.md](docs/development.md) §9 / §5.2。

## 7. 验收铁律（改完必做，做完才算完工）

1. `web build` + `server build` 须通过——**看退出码**（`nest build` 输出带 ANSI，`grep "error TS"` 会漏判）。
2. `server && npm test` 须全绿（CI 门禁）；**新增 spec 必须同步 `docs/development.md §5` 清单与计数**
   （`docStats.spec.mts` 锁定，活文档计数漂移即红；**断言数不进散文**）。
   改金额判定 / 状态流转 / 导入**必须另跑 `test:int`**。
3. **重启后端真打一个触发改动的请求**——dev 容器的 watch 不感知宿主机文件变更，
   必须 `docker compose -f docker-compose.dev.yml restart server`（不是 `up -d`）。
4. 改过 `schema.prisma` 必须生成并应用迁移，并复查列已落地。
5. 改前端 UI 时**真渲染核一眼**（构建发现不了"表头竖排"这类破版）：Edge headless + CDP，见 development.md §5.2。
6. 修完再验收到通过才完工；完成后按惯例**自动提交并推送（SSH）**。

## 8. 文档索引

| 文档 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 视觉规则、设计 token、组件样式约定 |
| [.claude/rules/](.claude/rules/) | 规则细则（按需加载，见 §4 表） |
| [TODO.md](TODO.md) | 剩余任务（只列未完成项，完成即删条目） |
| [docs/project-overview.md](docs/project-overview.md) / [architecture.md](docs/architecture.md) / [user-guide.md](docs/user-guide.md) | 项目说明 / 架构与数据流 / 使用说明 |
| [docs/development.md](docs/development.md) | 开发方式、命令、测试清单、回归清单、本机操作要点 |
| [docs/component-api.md](docs/component-api.md) | 前端组件与后端通用服务的接口 |
| [docs/02-数据库ER设计.md](docs/02-数据库ER设计.md) / [03-API接口清单.md](docs/03-API接口清单.md) | 数据模型 / REST 接口清单 |
| [docs/04-Docker镜像构建与优化.md](docs/04-Docker镜像构建与优化.md) / [05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md) | 镜像构建 / 四域扩展决策记录 |
| [README.md](README.md) | 部署与运维（Docker/NAS/CI） |

> **统计数字的两种待遇**：**活文档**（本文件、`docs/development.md`）里的 spec / model / 业务模块 /
> 增量迁移计数必须与代码一致（`docStats.spec.mts` 锁定）；**历史记录**（提交信息、`git log` 快照）
> 就地保留，**不要**追改。
