# CLAUDE.md · AI 进入本项目的必读信息

> 面向 AI 编码助手的项目入门。本文件只做**项目是什么 + 从哪里查规则**；
> 业务口径与编码细则全部登记在 [.claude/rules/](.claude/rules/)（按需加载，先读 [rules-index.md](.claude/rules/rules-index.md)）；
> 历史修复记录见 `git log`。

## 1. 这是什么

**企业合同管理系统（CMS）**：面向工程/采购型企业的合同全生命周期管理，覆盖
`项目 → 供应商/分包商 → 采购工作流 → 合同 → 日报/收领单 → 结算付款 → 发票 → 台账 → 还款协议` 主链路，
并配套模板、通知、看板与系统管理。

**技术栈**：前端 React 18 + TypeScript + Vite 5 + AntD 5 + Zustand + ECharts；
后端 NestJS 10 + Prisma 5 + **PostgreSQL 16**（唯一数据库）；鉴权 JWT + RBAC（权限码 `module:action`）；
包管理 npm（统一带 `--legacy-peer-deps`）。

## 2. 目录地图

```
Contract-Management/
├── CLAUDE.md  DESIGN.md  TODO.md  README.md  docs/
├── .claude/rules/      # 规则与产品口径（按需加载，先读 rules-index.md）
├── server/             # NestJS 后端
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
│   ├── src/common/     # 通用层：统一响应/异常/装饰器/Excel/导入/日志/系统参数/存储
│   ├── src/constants/  # procurementFlow.ts（采购工作流单一事实源）、statuses.ts、workflowGuards.ts
│   ├── src/modules/    # 27 个业务模块
│   ├── test/           # node:test 纯函数单测（39 个 spec，无 DB；清单见 docs/development.md §5）
│   └── test-integration/ # DB 集成测试（6 个 spec，需 PostgreSQL：npm run test:int）
├── web/                # React 前端（src/{api,components,constants,hooks,layouts,pages,store,utils}）
├── deploy/single/  docker-compose.yml  docker-compose.dev.yml  scripts/  .github/
```

## 3. 铁律速览

1. **数据库只用 PostgreSQL**，改模型出迁移，**禁 `prisma db push`**（CI 两道门禁）。
2. **接口统一返回** `{ code, data, message, timestamp }`，`code === 0` 为成功；前端 axios 已解包统一弹错。
3. **项目隔离**：service 在 `where` 里显式带 `projectId`，新增表/查询必须自己带过滤。
4. **字典驱动 + code 单一事实源**：状态码写常量（`SETTLEMENT_STATUS.DRAFT`），不裸写字符串。
5. **供应商信息不冗余**：合同只存 `supplierId`（例外：签订时快照）。

完整语义与例外清单见 [.claude/rules/rules-index.md](.claude/rules/rules-index.md)。

## 4. 常用命令

```bash
docker compose -f docker-compose.dev.yml up     # 本地开发（前端 :5173 / 后端 :3000 / PG :15432）

# 验收（改完必做）
cd web    && npm run build     # = tsc --noEmit && vite build
cd server && npm run build     # = nest build
cd server && npm test          # node:test 纯函数单测（39 个 spec，无 DB）
cd server && npm run test:int  # DB 集成测试（6 个 spec，改金额/状态/导入必跑）
```

## 5. 验收铁律

1. 两个 build 须通过——**看退出码**（`nest build` 输出带 ANSI，`grep "error TS"` 会漏判）。
2. `npm test` 须全绿（CI 门禁）；**新增 spec 必须同步 `docs/development.md §5` 清单与计数**
   （`docStats.spec.mts` 锁定；**断言数不进散文**）。改金额/状态/导入**必须另跑 `test:int`**。
3. **重启后端真打一个触发改动的请求**——dev 容器 watch 不感知宿主机变更，
   必须 `docker compose -f docker-compose.dev.yml restart server`（不是 `up -d`）。
4. 改过 `schema.prisma` 必须生成并应用迁移，并复查列已落地。
5. 改前端 UI 时**真渲染核一眼**（Edge headless + CDP，见 development.md §5.2）。
6. 修完再验收到通过才完工；完成后按惯例**自动提交并推送（SSH）**。

## 6. 文档索引

| 文档 | 内容 |
|---|---|
| [.claude/rules/rules-index.md](.claude/rules/rules-index.md) | **规则索引（改动前先查）**：按改动场景路由到细则文件 + 最高频 5 条 |
| [.claude/rules/product-decisions.md](.claude/rules/product-decisions.md) | **已定的产品口径**（业务决策登记，不要重新提议） |
| [.claude/rules/](.claude/rules/) 其余 | 细则：`backend-conventions` / `procurement-and-tender` / `import-and-templates` / `frontend-conventions` / `testing` |
| [DESIGN.md](DESIGN.md) | 视觉规则、设计 token、组件样式约定 |
| [TODO.md](TODO.md) | 剩余任务（只列未完成项，完成即删条目） |
| [docs/project-overview.md](docs/project-overview.md) / [architecture.md](docs/architecture.md) / [user-guide.md](docs/user-guide.md) | 项目说明 / 架构与数据流 / 使用说明 |
| [docs/development.md](docs/development.md) | 开发方式、命令、测试清单、回归清单、本机操作要点（§9） |
| [docs/component-api.md](docs/component-api.md) | 前端组件与后端通用服务的接口 |
| [docs/02-数据库ER设计.md](docs/02-数据库ER设计.md) / [03-API接口清单.md](docs/03-API接口清单.md) | 数据模型 / REST 接口清单 |
| [docs/04-Docker镜像构建与优化.md](docs/04-Docker镜像构建与优化.md) / [05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md) | 镜像构建 / 四域扩展决策记录 |
| [README.md](README.md) | 部署与运维（Docker/NAS/CI） |

> **统计数字的两种待遇**：**活文档**（本文件、`docs/development.md`）里的 spec / model / 业务模块 /
> 增量迁移计数必须与代码一致（`docStats.spec.mts` 锁定）；**历史记录**（提交信息、`git log` 快照）
> 就地保留，**不要**追改。
