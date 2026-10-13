# AGENTS.md · AI 进入本项目的必读信息

> 面向 AI 编码助手的项目入门。**动手前先读完本文件**，其余细节见文末索引。

## 1. 这是什么

**企业合同管理系统（CMS）**：面向工程/采购型企业的合同全生命周期管理，覆盖
`项目 → 供应商/分包商 → 采购工作流 → 合同 → 日报/收领单 → 结算付款 → 发票 → 台账 → 还款协议` 主链路，
并配套模板、审批、通知、看板与系统管理。

- 前端：React 18 + TypeScript + Vite 5 + Ant Design 5 + Zustand + ECharts
- 后端：NestJS 10 + Prisma 5 + **PostgreSQL 16**（唯一数据库，无 sqlite 分支）
- 鉴权：JWT + RBAC（权限码 `module:action`）
- 包管理：**pnpm**（lockfile v9，`packageManager: pnpm@12.3.4`，勿用 npm）

## 2. 目录地图

```
Contract-Management/
├── AGENTS.md            # 本文件
├── DESIGN.md            # 视觉规则
├── TODO.md              # 任务与进度
├── README.md            # 部署与快速开始（面向运维）
├── docs/                # 参考文档（见 §8）
│   ├── 01-需求确认摘要.md 02-数据库ER设计.md 03-API接口清单.md   # 早期需求/设计文档
│   └── project-overview.md architecture.md user-guide.md development.md component-api.md
├── server/              # NestJS 后端
│   ├── prisma/schema.prisma        # 全量数据模型（50 个 model，1253 行）
│   ├── prisma/migrations/20260901000000_init/  # 折叠基线（唯一迁移）
│   ├── prisma/seed.ts  src/seed.ts  src/seed-data.ts
│   ├── src/common/     # 通用层：统一响应/异常/装饰器/Excel/导入/日志/系统参数
│   ├── src/constants/  # procurementFlow.ts（采购工作流单一事实源）、workflowGuards.ts
│   ├── src/modules/    # 22 个业务模块
│   └── test/           # node:test 单测（3 个 spec）
├── web/                 # React 前端
│   └── src/{api,components,constants,hooks,layouts,pages,store,utils}
├── deploy/single/       # 单容器部署：Dockerfile.single / nginx.conf / start.sh
├── docker-compose.yml   # 生产部署入口（postgres + cms 单容器）
├── docker-compose.dev.yml  # 本地开发（源码热重载）
└── scripts/ .github/workflows/build.yml hooks/
```

## 3. 五条铁律（违反必踩坑）

1. **数据库只用 PostgreSQL**。改模型改 `server/prisma/schema.prisma`，用
   `npx prisma migrate dev --name xxx` 生成迁移；**禁止 `prisma db push`**（会让库脱离迁移历史，
   问题只在别人/生产上暴露）。`20260901000000_init` 是「空库 → 当前 schema」的折叠基线。
2. **接口统一返回** `{ code, data, message, timestamp }`，`code === 0` 为成功；
   错误码 1001 参数错误 / 1401 未登录 / 1403 无权限 / 1500 服务端异常。
   前端 axios 已解包 `data` 并统一弹错，页面里通常不要再重复提示。
3. **项目隔离靠约定，不是中间件**。控制器用 `@ProjectId()` 取 `x-project-id`，
   service 在 `where` 里显式带 `projectId`。**新增业务表/查询必须自己带上过滤**，
   否则会跨项目泄漏数据。例外：`dict` 全局、`finance` 按 `contractId` 归属、
   `supplier` 受系统参数 `supplier.share.scope`（GLOBAL/PROJECT）控制。
4. **字典驱动**：所有下拉/标签/颜色来自 `dict_type`/`dict_item`，业务表存**字典项编码字符串**
   （不用数据库枚举）。前端用 `DictSelect`/`DictTag`，后端用 `dict.service` 校验。
5. **供应商信息不冗余**：合同只存 `supplierId`，法人/联系人/银行等由供应商库实时关联。

## 4. 改动前必看的高危约定

- **采购工作流有单一事实源**：后端 `server/src/constants/procurementFlow.ts` 与前端
  `web/src/constants/procurementWorkflow.ts` 是**互为镜像**的两份常量，由
  `server/test/frontendChainParity.spec.mts` 锁死一致性。**必须同步改**，否则测试红。
- **菜单权威来源是后端** `GET /api/menu`（`server/src/modules/system/menu.service.ts` 的 `MENU_TREE`）。
  只改前端 `web/src/components/Sider/menuConfig.ts` 无效（它只是接口失败时的兜底）。
  新增菜单图标须在 `Sider/utils/iconHelper.tsx` 的 `ICON_MAP` 注册；改菜单结构后递增
  `Sider/utils/storage.ts` 的缓存键版本（当前 `_v2`）。
- **乐观锁**：业务表多有 `version Int`，更新时用 `helpers.assertVersion(old, data)`（不一致抛 409）。
- **导入**：走 `ImportRunnerService` 两阶段（先全量校验出计划，全通过才在事务内写入）——**全成功或全失败**；
  超过 1000 行自动转异步任务（`ImportTaskService`，返回 taskId 供轮询）。
- **写字段白名单**：service 用 `common/pick-fields.ts` 的 `pickFields` 过滤未知字段，防前端字段漂移 500。

## 5. 前端两个"反直觉"现状

- **无路由懒加载、无路由级权限守卫**：`web/src/router.tsx` 所有页面静态 import；
  权限只体现在侧边菜单过滤（`useAuthStore.hasPermission`）。
- **新旧两套路由并存**：旧扁平路径（`/contracts`、`/projects`）与 Sider 新规范路径
  （`/contract/list`、`/base/project`）指向同一组件，迁移期兼容，勿删。

## 6. 常用命令

```bash
# 本地开发（推荐：容器化热重载）
docker compose -f docker-compose.dev.yml up     # 前端 :5173 / 后端 :3000 / PG :15432

# 宿主机直跑
cd server && pnpm install && pnpm prisma:deploy && pnpm run seed && pnpm start:dev
cd web    && pnpm install && pnpm dev

# 验收（改完必做）
cd web    && pnpm run build     # = tsc --noEmit && vite build
cd server && pnpm run build     # = nest build
cd server && pnpm test          # node:test 单测（procurementFlow / workflowGuards / 前后端链一致性）
```

完整清单见 [docs/development.md](docs/development.md)。

## 7. 验收铁律（改完必做，做完才算完工）

1. `cd web && pnpm run build`（含 `tsc --noEmit`）、`cd server && pnpm run build` 均须通过。
2. **重启后端真打一个触发改动的请求**确认不报旧错——只看启动日志不算。
3. 改过 `schema.prisma` 必须生成并应用迁移，并复查列已落地。
4. 修完再验收到通过才完工，不要"改完即报完成"。

## 8. 文档索引

| 文档 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 视觉规则、设计 token、组件样式约定 |
| [TODO.md](TODO.md) | 当前任务、优先级与进度 |
| [docs/project-overview.md](docs/project-overview.md) | 项目整体说明（是什么、给谁用、能做什么） |
| [docs/architecture.md](docs/architecture.md) | 架构与数据流 |
| [docs/user-guide.md](docs/user-guide.md) | 面向使用者的功能说明 |
| [docs/development.md](docs/development.md) | 开发方式、命令、回归清单 |
| [docs/component-api.md](docs/component-api.md) | 前端组件与后端通用服务的接口 |
| [docs/03-API接口清单.md](docs/03-API接口清单.md) | REST 接口清单（⚠️ 部分内容滞后，待重写；以 controller 为准） |
| [docs/04-Docker镜像构建与优化.md](docs/04-Docker镜像构建与优化.md) | 单容器镜像构建、踩坑与取舍 |
| [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md) | 招标/合同/采购/进出场四域扩展评估 + 决策记录（组件选型、设计建议） |
| [docs/06-变量体系梳理与歧义清单.md](docs/06-变量体系梳理与歧义清单.md) | 采购/合同模板变量两套体系梳理 + 8 项歧义/缺陷清单 |
| [docs/07-工作域信息关联审计.md](docs/07-工作域信息关联审计.md) | 工作域信息关联审计（悬空外键、弱关联、核销缺失） |
| [docs/08-全局响应式改造方案.md](docs/08-全局响应式改造方案.md) | 全局响应式改造方案（布局/表格/弹窗分层 + 阶段与工作量） |
| [README.md](README.md) | 部署与运维（Docker/NAS/CI） |

> ⚠️ `.workbuddy/memory/` 下的项目记忆停留在 2026-09 中旬，其中「Prisma 双 schema（sqlite）」
> 「资审报告阶段」等描述**已过时**（项目已于 2026-09-17 收敛为 PostgreSQL 单 schema，
> 并移除资审报告）。以代码与本文档为准。
