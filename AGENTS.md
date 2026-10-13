# AGENTS.md · AI 进入本项目的必读信息

> 面向 AI 编码助手的项目入门。**动手前先读完本文件**，其余细节见文末索引。

## 1. 这是什么

**企业合同管理系统（CMS）**：面向工程/采购型企业的合同全生命周期管理，覆盖
`项目 → 供应商/分包商 → 采购工作流 → 合同 → 日报/收领单 → 结算付款 → 发票 → 台账 → 还款协议` 主链路，
并配套模板、审批、通知、看板与系统管理。

- 前端：React 18 + TypeScript + Vite 5 + Ant Design 5 + Zustand + ECharts
- 后端：NestJS 10 + Prisma 5 + **PostgreSQL 16**（唯一数据库，无 sqlite 分支）
- 鉴权：JWT + RBAC（权限码 `module:action`）
- 包管理：**npm**（锁文件 `server/package-lock.json`、`web/package-lock.json` **已入库**；
  安装统一带 `--legacy-peer-deps`，与镜像/CI 的 `npm ci --legacy-peer-deps` 对齐；勿用 pnpm/yarn）

## 2. 目录地图

```
Contract-Management/
├── AGENTS.md            # 本文件
├── DESIGN.md            # 视觉规则
├── TODO.md              # 剩余任务（只列未完成项，完成即删除条目）
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

- **新增采购阶段子模块需同步改六处**（漏一处必现"页面有、取值空"）：`schema.prisma`（含**两侧反引用**）→
  迁移 SQL → service（`xxx()/saveXxx()/serializeXxx()/publish()` 校验）→ controller（GET+PUT）→
  前端 `api/modules.ts` + `constants/procurementVariables.ts` → `utils/<模块>.ts` + 页面。
- **加外键必须在同一迁移内先做数据清洗**（空串归一为 NULL、悬空引用置 NULL；不可空列则以
  `RAISE EXCEPTION` 拦截而非静默删行），否则线上库 `ADD CONSTRAINT` 直接失败；
  新增 `xxxId` 字段须建 `@relation` 或登记进 `server/test/schemaDanglingRefs.spec.mts` 的白名单。
  范例见 `server/prisma/migrations/20261014000000_p1_consistency/migration.sql`。
- **采购工作流有单一事实源**：后端 `server/src/constants/procurementFlow.ts` 与前端
  `web/src/constants/procurementWorkflow.ts` 是**互为镜像**的两份常量，由
  `server/test/frontendChainParity.spec.mts` 锁死一致性。**必须同步改**，否则测试红。
- **菜单权威来源是后端** `GET /api/menu`（`server/src/modules/system/menu.service.ts` 的 `MENU_TREE`）。
  只改前端 `web/src/components/Sider/menuConfig.ts` 无效（它只是接口失败时的兜底）。
  新增菜单图标须在 `Sider/utils/iconHelper.tsx` 的 `ICON_MAP` 注册；改菜单结构后递增
  `Sider/utils/storage.ts` 的缓存键版本（当前 `_v3`）。
- **乐观锁**：业务表多有 `version Int`，更新时用 `helpers.assertVersion(old, data)`（不一致抛 409）。
- **导入**：走 `ImportRunnerService` 两阶段（先全量校验出计划，全通过才在事务内写入）——**全成功或全失败**；
  超过 1000 行自动转异步任务（`ImportTaskService`，返回 taskId 供轮询）。
- **写字段白名单**：service 用 `common/pick-fields.ts` 的 `pickFields` 过滤未知字段，防前端字段漂移 500。
- **合同阶段的任务状态由「主合同」决定**：映射是纯函数 `contractStageTaskStatus()`
  （`server/src/constants/procurementFlow.ts`）：草稿→合同编制中 / 审批中→合同审批中 / 已签章→已完成。
  合同侧在**签章、状态互转、提交、驳回**时自动同步任务状态（`contract.service.ts` 的
  `syncLinkedTaskStatus`），`POST /procurement-tasks/:id/sync-contract-status` 只作人工兜底。
  ⚠️ 「主合同」= 该任务**最早创建**的合同（同批生成时再按编号排序）；`GET /contracts` 列表按
  `createdAt DESC`，**`list[0]` 不是主合同**，别拿它判定（E2E 曾因此写错断言）。
- **日报行是结算量的唯一来源**：`DailyReport` 是「现场记录」的落点（收领单推送也生成日报行），
  每行带**现场确认状态** `confirmStatusCode`（dict `site_confirm_status`）。
  - 状态机守卫 `assertSiteConfirmable()`（`constants/workflowGuards.ts`），状态只能经
    `POST /daily-reports/confirm` 变更（`create/update` 不接受前端直传确认字段）；
  - **口径开关** `settlement.require_confirmed`（默认 `true`）：开启时「已确认」以外（含待确认/已驳回/空值）
    的现场记录**不计入结算口径**（`contract-settled-qty` 会过滤）；置 `false` 回到改造前行为；
  - 收领单推送生成的行由 `receipt-order.service` 直接置「已确认」（现场签收即确认）；
  - ⚠️ **改 `web/src/pages/DailyReports.tsx` 的 `FIELDS` 时，key 必须与 Prisma 模型字段逐字一致**
    ——该数组同时驱动表格列与表单字段，错一个字 = 表格列空白 + 保存 500（历史上错了 10 个）。
- **金额上限（防超结/防超付）**：口径与判定在零依赖模块 `common/utils/amount-guard.ts`
  （上限 = 合同链「主合同 + 补充协议」金额；累计结算**排除草稿**；累计付款**排除付款失败/已退款**）。
  策略由系统参数 `settlement.over_amount_policy` / `payment.over_amount_policy` 控制
  （`BLOCK` 拦截 / `WARN` 仅提示 / `OFF` 关闭，默认 `WARN`）；改判定规则请同步改 `amountGuard.spec.mts`。
  注：清单项级「结算量 ≤ 已确认量」的量级校验**尚未做**（需先定变更口径，见 docs/09 §7）。
- **合同台账列宽的单位契约**：`LEDGER_COLUMNS[].width`
  （`server/src/modules/ledger/ledger-columns.ts`）是 **Excel 字符宽（8~30）**，
  接口对外输出前由 `ledgerColumnWidthPx()`（≈8px/字符、100px 下限）换算为**像素**。
  **不要**把字符宽直接当像素交给 antd——历史上正是如此把 42 列表头挤成竖排文字（桌面端也破版）。
  契约由 `server/test/ledgerColumns.spec.mts` 双向锁定。
- **项目字段名 ↔ 文档上下文名不一致（易错）**：`GET /projects/:id` 返回 Project 原始记录
  （`name` / `nameAbbr` / `code` / `materialOrigin`），而采购文档上下文用 `projectName` /
  `projectAbbr` / `projectCode` / `materialOrigin`，映射在 `web/src/utils/procurementTaskDocs.ts`
  的 `baseCtx`。**误用旧名会让公共变量静默取空**（曾整批导出文档项目信息为空），有测试兜底。
- **采购变量的命名与单位**：金额类变量名**必须带单位后缀**（`预计采购金额(万元)` / `(元)`）——
  同名不同单位即视为缺陷；旧名经 `PROCUREMENT_VAR_ALIASES` 单向兼容，面板只展示规范名。
  改/加变量必须**同时**改面板定义（`web/src/constants/procurementVariables.ts`）与取值表
  （各 `utils/procurement*.ts` 的 `build*VariableValues`），否则变量漂移锁测试红。
- **依赖管理统一用 npm**：锁文件 `server|web/package-lock.json` **必须入库**（镜像与 CI 走
  `npm ci --legacy-peer-deps`，缺锁文件直接失败）；改了依赖要在对应目录跑
  `npm install --package-lock-only --legacy-peer-deps` 刷新锁文件并一并提交。**勿用 pnpm/yarn**
  （`pnpm-lock.yaml` 已移除）。

## 5. 前端约定（改动前必读）

- **路由懒加载 + 路由级权限守卫已具备**：`web/src/router.tsx` 全部页面改用 `React.lazy`，
  加载兜底 `Suspense` 在 `BasicLayout` 内（只替换内容区，侧栏不闪）；
  页面元素统一走 `perm(path, <Page/>)` 工厂，按 `web/src/constants/routePermissions.ts`
  自动包 `RequirePermission`（403 页，不重定向）。
  **新增页面必须**：① 用 `perm('/新路径', <Page/>)` 而非裸元素；② 若后端 `menuTree.ts` 给该菜单项配了
  `permission`，必须在 `ROUTE_PERMISSIONS` 登记同一权限码——`server/test/routePermissionParity.spec.mts`
  会校验，且**守卫不得比菜单更严**（否则出现「菜单可见、点进去 403」）。
  菜单中带权限但有意不守卫的路径须登记进 `ROUTE_PERMISSION_EXCEPTIONS`（现有：`/dashboard`，默认落地页）。
- **旧扁平路径改为重定向保号**：旧路径（`/projects`、`/ledger`、`/daily` …）通过
  `<Navigate to="/新路径" replace />` 跳到 Sider 新规范路径，书签不失效，但**不再重复渲染同一组件**。
  例外：`/contracts`（合同编辑页）在新菜单中无对应入口，保留为真实路由，去留待业务确认。
- **断点唯一来源是 `useResponsive()`**（`web/src/hooks/useResponsive.ts`）：**禁止**组件内使用
  `window.innerWidth` / `matchMedia`。具体规格（`isMobile(<768)`）、四条硬性约定（Col 带断点、
  Table 声明 `scroll`、弹窗宽度可被全局兜底、≤md 侧栏走 Drawer）与明确取舍见
  [DESIGN.md](DESIGN.md) §10。
- **前端纯逻辑单测放在 `server/test/*.spec.mts`**（**不引入** jest/vitest）：直接 import `web/src/**` 中
  **无 `@/` 别名、无运行时 `import`** 的模块（`import type` 可，会被擦除）。`.mts` 由 Node 原生
  擦除类型加载，故 **Node 需 ≥22.18**（本地 v24、CI 用 24）——`node:20` 会直接报错。
  spec 清单见 [docs/development.md](docs/development.md) §5。

## 6. 常用命令

```bash
# 本地开发（推荐：容器化热重载）
docker compose -f docker-compose.dev.yml up     # 前端 :5173 / 后端 :3000 / PG :15432

# 宿主机直跑
cd server && npm ci --legacy-peer-deps && npm run prisma:deploy && npm run seed && npm run start:dev
cd web    && npm ci --legacy-peer-deps && npm run dev

# 验收（改完必做）
cd web    && npm run build     # = tsc --noEmit && vite build
cd server && npm run build     # = nest build
cd server && npm test          # node:test 单测（7 个 spec，见 docs/development.md）
```

完整清单见 [docs/development.md](docs/development.md)。

## 7. 验收铁律（改完必做，做完才算完工）

1. `cd web && npm run build`（含 `tsc --noEmit`）、`cd server && npm run build` 均须通过。
2. `cd server && npm test` 须全绿（8 个 spec / 102 项断言）——该 job 已进 CI 门禁，
   `.github/workflows/build.yml` 的 `build` 依赖 `test`，**测试红则不发布新镜像**。
3. **重启后端真打一个触发改动的请求**确认不报旧错——只看启动日志不算。
4. 改过 `schema.prisma` 必须生成并应用迁移，并复查列已落地。
5. 改前端 UI 时**真渲染核一眼**（构建通过发现不了"表头竖排"这类破版）；
   本机无 Playwright，用 Edge headless + CDP 手法，见 `.workbuddy/memory/MEMORY.md` 末节。
6. 修完再验收到通过才完工，不要"改完即报完成"。

## 8. 文档索引

| 文档 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 视觉规则、设计 token、组件样式约定 |
| [TODO.md](TODO.md) | 剩余任务与优先级（**只列未完成项**，完成即删除条目） |
| [docs/project-overview.md](docs/project-overview.md) | 项目整体说明（是什么、给谁用、能做什么） |
| [docs/architecture.md](docs/architecture.md) | 架构与数据流 |
| [docs/user-guide.md](docs/user-guide.md) | 面向使用者的功能说明 |
| [docs/development.md](docs/development.md) | 开发方式、命令、回归清单 |
| [docs/component-api.md](docs/component-api.md) | 前端组件与后端通用服务的接口 |
| [docs/03-API接口清单.md](docs/03-API接口清单.md) | REST 接口清单（24 组，已按 controller 重出并与实现一致，含权限码与项目隔离口径） |
| [docs/04-Docker镜像构建与优化.md](docs/04-Docker镜像构建与优化.md) | 单容器镜像构建、踩坑与取舍 |
| [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md) | 招标/合同/采购/进出场四域扩展评估 + 决策记录（组件选型、设计建议） |
| [docs/06-变量体系梳理与歧义清单.md](docs/06-变量体系梳理与歧义清单.md) | 采购/合同模板变量两套体系梳理 + 8 项歧义/缺陷清单 |
| [docs/07-工作域信息关联审计.md](docs/07-工作域信息关联审计.md) | 工作域信息关联审计（悬空外键、弱关联、核销缺失） |
| [docs/08-全局响应式改造方案.md](docs/08-全局响应式改造方案.md) | 全局响应式改造方案（布局/表格/弹窗分层 + 阶段与工作量） |
| [docs/09-重构方案评估与采纳建议.md](docs/09-重构方案评估与采纳建议.md) | 外部重构方案评估（已具备/真缺口/冲突三类）+ 现场确认与防超结落地记录 + 4 项待业务澄清 |
| [README.md](README.md) | 部署与运维（Docker/NAS/CI） |

> ⚠️ `.workbuddy/memory/` 下的项目记忆停留在 2026-09 中旬，其中「Prisma 双 schema（sqlite）」
> 「资审报告阶段」等描述**已过时**（项目已于 2026-09-17 收敛为 PostgreSQL 单 schema，
> 并移除资审报告）。以代码与本文档为准。
