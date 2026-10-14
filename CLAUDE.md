# CLAUDE.md · AI 进入本项目的必读信息

> 面向 AI 编码助手的项目入门。**动手前先读完本文件**，其余细节见文末索引。
> 本文件只写**现状**与**会踩的坑**；历史修复记录见 [docs/09](docs/09-重构方案评估与采纳建议.md) §8 等
> 「当时快照」与 `git log`，不再搬到这里。

## 1. 这是什么

**企业合同管理系统（CMS）**：面向工程/采购型企业的合同全生命周期管理，覆盖
`项目 → 供应商/分包商 → 采购工作流 → 合同 → 日报/收领单 → 结算付款 → 发票 → 台账 → 还款协议` 主链路，
并配套模板、通知、看板与系统管理。
（注：**没有审批流模型**——合同的"审批"只是 `status` + `/sign` + `/reject`；是否要做可配置多级审批见 TODO。）

- 前端：React 18 + TypeScript + Vite 5 + Ant Design 5 + Zustand + ECharts
- 后端：NestJS 10 + Prisma 5 + **PostgreSQL 16**（唯一数据库）
- 鉴权：JWT + RBAC（权限码 `module:action`）
- 包管理：**npm**（锁文件 `server/package-lock.json`、`web/package-lock.json` **已入库**；
  安装统一带 `--legacy-peer-deps`，与镜像/CI 的 `npm ci --legacy-peer-deps` 对齐）

## 2. 目录地图

```
Contract-Management/
├── CLAUDE.md            # 本文件（现状与陷阱）
├── DESIGN.md            # 视觉与交互规则（token 唯一来源）
├── TODO.md              # 剩余任务（只列未完成项，完成即删除条目）
├── README.md            # 部署与快速开始（面向运维）
├── docs/                # 参考文档（见 §8）
├── server/              # NestJS 后端
│   ├── prisma/schema.prisma        # 全量数据模型（52 个 model）
│   ├── prisma/migrations/          # 折叠基线 20260901000000_init + 6 个增量迁移
│   │                               #   （p1_consistency / site_confirmation / scrub_log_secrets
│   │                               #    / import_task_recovery / canonicalize_template_placeholders
│   │                               #    / tender_bidder_and_evaluation）
│   ├── prisma/seed.ts  src/seed.ts  src/seed-data.ts
│   ├── src/common/     # 通用层：统一响应/异常/装饰器/Excel/导入/日志/系统参数/存储
│   ├── src/constants/  # procurementFlow.ts（采购工作流单一事实源）、statuses.ts、workflowGuards.ts
│   ├── src/modules/    # 22 个业务模块
│   ├── test/           # node:test 纯函数单测（24 个 spec，无 DB；清单见 docs/development.md §5）
│   └── test-integration/ # DB 集成测试（4 个 spec，需 PostgreSQL：npm run test:int）
├── web/                 # React 前端
│   └── src/{api,components,constants,hooks,layouts,pages,store,utils} + theme.ts + index.css
├── deploy/single/       # 单容器部署：Dockerfile.single / nginx.conf / start.sh
├── docker-compose.yml       # 生产部署入口（postgres + cms 单容器）
├── docker-compose.dev.yml   # 本地开发（源码热重载）
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
4. **字典驱动 + code 单一事实源**：所有下拉/标签/颜色来自 `dict_type`/`dict_item`，业务表存**字典项编码字符串**
   （不用数据库枚举）。前端用 `DictSelect`/`DictTag`，后端用 `dict.service` 校验。
   **但 code 本身不许各处裸写**：核心状态码的单一事实源是
   `server/src/constants/statuses.ts` 与 `server/src/constants/procurementFlow.ts`，
   service 里写 `SETTLEMENT_STATUS.DRAFT` 而不是 `'DRAFT'`；字典 typeCode 用 `DICT_TYPES.*`。
   两侧由 `server/test/statusCodes.spec.mts` **双向锁死**（常量 ↔ 字典项 ↔ `schema.prisma` 的 enum）。
5. **供应商信息不冗余**：合同只存 `supplierId`，法人/联系人/银行等由供应商库实时关联。

## 4. 改动前必看的高危约定

> 每条都配了「锁定它的测试」或「细节所在的文档」——**改动前先看那一处**，别只看本行摘要。

- **新增采购阶段子模块需同步改六处**（漏一处必现"页面有、取值空"）：`schema.prisma`（含**两侧反引用**）→
  迁移 SQL → service（`xxx()/saveXxx()/serializeXxx()/publish()` 校验）→ controller（GET+PUT）→
  前端 `api/modules.ts` + `constants/procurementVariables.ts` → `utils/<模块>.ts` + 页面。
- **加外键必须在同一迁移内先做数据清洗**（空串归一为 NULL、悬空引用置 NULL；不可空列则以
  `RAISE EXCEPTION` 拦截而非静默删行），否则线上库 `ADD CONSTRAINT` 直接失败；
  新增 `xxxId` 字段须建 `@relation` 或登记进 `schemaDanglingRefs.spec.mts` 的白名单。
  范例：`prisma/migrations/20261014000000_p1_consistency/migration.sql`。
- **采购工作流有单一事实源**：后端 `constants/procurementFlow.ts` 与前端
  `web/src/constants/procurementWorkflow.ts` 是**互为镜像**的两份常量，由
  `frontendChainParity.spec.mts` 锁死。**必须同步改**，否则测试红。
- **菜单权威来源是后端** `GET /api/menu`（`modules/system/menu.service.ts` 的 `MENU_TREE`）——
  只改前端 `Sider/menuConfig.ts` 无效（它只是接口失败时的兜底）。新增图标要在
  `Sider/utils/iconHelper.tsx` 的 `ICON_MAP` 注册；改菜单结构后递增 `Sider/utils/storage.ts` 的缓存键版本。
- **乐观锁**：业务表多有 `version Int`，更新时用 `helpers.assertVersion(old, data)`（不一致抛 409）。
- **写字段白名单**：service 用 `common/pick-fields.ts` 的 `pickFields` 过滤未知字段，防前端字段漂移 500。
- **导入两阶段**（`ImportRunnerService`）：先全量校验出计划，全通过才在事务内写入——**全成功或全失败**；
  >1000 行转异步任务（`ImportTaskService` 返回 taskId）。两条配套机制别绕开：
  **执行期心跳**（`execute()` 写 `lockedAt`，`reapStaleTasks()` 每 5 分钟回收 >10 分钟无心跳的任务，
  判据 `isImportTaskStale()`）与**幂等去重**（同文件 sha1 在 PENDING/RUNNING 期间复用既有任务，
  `submit()` 用 PG 事务级咨询锁串行化同键提交）。⚠️ 去重命中后**绝不能再跑一次 execute**。
  锁定：`importTask.spec.mts` + `test-integration/import-two-phase.int.spec.ts`。
- **日志必须脱敏（白名单）**：操作日志拦截器把「请求参数 + 变更前后快照」整体写入 `OperationLog`
  （日志页仅需 `system:user` 权限即可查看），**凭据/银行账号/证件号/联系方式不得明文入库**。
  规则集中在 `common/utils/mask.ts`（`slimSecrets()` 深拷贝后按键名打码，**不改原对象**）；
  新增敏感字段须登记进 `SECRET_FIELD_KEYS`，契约由 `mask.spec.mts` 锁定。
- **合同阶段的任务状态由「主合同」决定**：纯函数 `contractStageTaskStatus()`（草稿→合同编制中 /
  审批中→合同审批中 / 已签章→已完成）；合同侧在签章、状态互转、提交、驳回时自动同步
  （`contract.service.syncLinkedTaskStatus`），`POST /procurement-tasks/:id/sync-contract-status` 只作人工兜底。
  ⚠️ 「主合同」= 该任务**最早创建**的合同；`GET /contracts` 按 `createdAt DESC`，**`list[0]` 不是主合同**。
- **日报行是结算量的唯一来源**：`DailyReport` 每行带现场确认状态 `confirmStatusCode`（dict
  `site_confirm_status`），状态只能经 `POST /daily-reports/confirm` 变更（`create/update` 不接受直传）；
  口径开关 `settlement.require_confirmed`（默认 `true`）开启时，非「已确认」的现场记录**不计入结算口径**。
  ⚠️ 改 `web/src/pages/DailyReports.tsx` 的 `FIELDS` 时，**key 必须与 Prisma 模型字段逐字一致**
  （该数组同时驱动表格列与表单字段，错一个字 = 列空白 + 保存 500）。细节见 docs/09 §8 A。
- **金额上限（防超结/防超付）**：判定在零依赖模块 `common/utils/amount-guard.ts`
  （上限 = 合同链「主合同 + 补充协议」金额；累计结算排除草稿；累计付款排除失败/退款），
  策略由系统参数 `settlement.over_amount_policy` / `payment.over_amount_policy` 控制
  （`BLOCK`/`WARN`/`OFF`，默认 `WARN`）。⚠️ **合同链未填金额时返回 `null` = 无上限**，
  别把「无金额」当成上限 0（否则 BLOCK 下会拦住合法单据）。锁定：`amountGuard.spec.mts` +
  `test-integration/amount-guard.int.spec.ts`。细节见 docs/09 §8 B。
- **招标域：结构化行是事实源，JSON 只是发布快照**：导入「响应单位情况汇总表」时同一事务内**双写**
  `ProcurementResultReport.suppliers`（JSON 快照）与 `ProcurementBidder`（唯一键 `(taskId, bidderName)`）；
  **定标 = 勾选「拟推荐成交候选人」**（置 `WON` + 写最终确认价，取消勾选回落入围/已递交）。
  ⚠️ **生成合同的单位与金额只从结构化中标行取**（`candidatesFromBidders()` → `resolveContractUnits()`），
  **别改回读 JSON `candidates`**——已有「刻意篡改快照也不采信」的集成判据挡着。
  存量回填由 `ensureBiddersFromSnapshot()` 幂等完成（无一次性脚本）。细节见 docs/05 §6.2、docs/02。
- **采购总清单会带入合同起草清单**：任务全阶段发布后自动生成合同时，
  `contract.service.seedDraftFromProcurementItems()` 把 `ProcurementTotalItem` 幂等带入
  `ContractDraftMaterial`（`qty ← qty`、`priceBeforeTax ← planPrice`、`unit ← unit`，税率按合同主表税率，
  含税单价与合价服务端重算）；带入失败只记日志、**不阻断**合同生成。细节见 docs/09 §8.1。
- **合同台账列宽的单位契约**：`modules/ledger/ledger-columns.ts` 的 `LEDGER_COLUMNS[].width` 是
  **Excel 字符宽（8~30）**，输出前由 `ledgerColumnWidthPx()`（≈8px/字符、100px 下限）换算成**像素**。
  **不要把字符宽当像素交给 antd**（会把表头挤成竖排文字）。锁定：`ledgerColumns.spec.mts`。
- **文件落盘只有一条路**：`common/services/storage.service.ts`（`StorageService`，上传/签章件/导入错误报告
  三个写入点都走它）——**不要在 service/controller 里自己拼 `UPLOAD_DIR` 与文件名**；键是**相对 POSIX 路径**
  （`signed/x.pdf`，用 `/` 不用 `path.join`），对外 URL = `/api/files/<键>`，越权键一律 400。
  ⚠️ multer 的 `destination/filename` 回调在**类定义期**求值，`this` 不是控制器实例。
  换对象存储只需实现同一个 `StorageLike` 并改 `common.module.ts` 的 provider 绑定 + `main.ts` 静态服务。
  细节见 [docs/component-api.md](docs/component-api.md)。
- **采购模板变量与合同模板变量是两套体系**（互不相通、由不同代码替换）：金额类变量名**必须带单位后缀**
  （`预计采购金额(万元)`/`(元)`），旧名经 `PROCUREMENT_VAR_ALIASES` 单向兼容；改/加变量必须**同时**改面板定义
  （`web/src/constants/procurementVariables.ts`）与取值表（各 `utils/procurement*.ts` 的 `build*VariableValues`），
  否则 `procurementVariables.spec.mts` 红。每个变量面板都要标 `variableScope`（否则作者会插错体系的变量且**静默不替换**）。
  另：`GET /projects/:id` 返回 `name/nameAbbr/code`，而文档上下文用 `projectName/projectAbbr/projectCode`，
  映射在 `utils/procurementTaskDocs.ts` 的 `baseCtx`——**误用旧名会让公共变量静默取空**。
- **合同模板占位符只认双花括号** `{{变量名}}`（表格占位符 `{{物料编码清单}}`/`{{合同清单}}` 同类），
  渲染是零依赖纯函数 `template-render.ts` 的 `renderTemplate()`；**别再为单花括号加兼容分支**。
  ⚠️ **种子模板有两处，别只改一处**：`prisma/templates/*.ts` **和 `prisma/seed.ts` 里内联的 3 份**
  （后者只在空库 + `npm run seed` 时创建，改动当时不可见）。两道防线：`templateRender.spec.mts` +
  `templatePlaceholderSyntax.spec.mts`（源码扫描 + 渲染无残留）。改模板后重跑
  `npx ts-node prisma/templates/upsert-purchase-exec.ts`（真 upsert）。细节见 docs/06 §3。

## 5. 前端约定（改动前必读）

- **路由懒加载 + 路由级权限守卫**：`web/src/router.tsx` 全部页面 `React.lazy`；页面元素统一走
  `perm(path, <Page/>)` 工厂，按 `constants/routePermissions.ts` 自动包 `RequirePermission`（403 页）。
  **新增页面必须**：① 用 `perm(...)` 而非裸元素；② 若后端 `menuTree.ts` 给该菜单配了 `permission`，
  必须在 `ROUTE_PERMISSIONS` 登记同一权限码（`routePermissionParity.spec.mts` 校验），
  且**守卫不得比菜单更严**；有意不守卫的路径登记进 `ROUTE_PERMISSION_EXCEPTIONS`（现有 `/dashboard`）。
- **改视觉只改 token 层**：`web/src/theme.ts`（色板/语义色/图表配色/antdTheme）、`index.css` 的 `--cms-*`、
  `components/Sider/index.less`（LESS 用不了 `var()`）；**页面/组件里不许写死 `#hex`/`rgb()`**
  （`themeTokens.spec.mts` 锁定，白名单仅编辑器调色板与 Word 内联样式）。状态色**不重命名**
  （字典与 `TASK_STATUS_COLORS` 是语义名 + 前后端镜像），换色在渲染层映射。
  改视觉前读 [DESIGN.md](DESIGN.md)（含"不搬 Anthropic 商标"等取舍）。
- **断点唯一来源是 `useResponsive()`**：**禁止**组件内用 `window.innerWidth`/`matchMedia`；
  四条硬性约定（Col 带断点、Table 声明 `scroll`、弹窗宽度可被全局兜底、≤md 侧栏走 Drawer）见 DESIGN.md §10。
- **列表页列显隐有两条路**：通用列表页 `ModuleListPage.columnConfigKey`（偏好存 **localStorage**，
  纯逻辑在 `utils/listColumns.ts`）与合同台账 `ledger.columns.config`（**服务端共享**）。
  **别混用**（给台账页再传 `columnConfigKey` 会出现两套列设置打架）。
- **两套测试别混用**：`server/test/*.spec.*`（纯函数/漂移锁，无 DB、秒级，`npm test`）与
  `server/test-integration/*.int.spec.ts`（真库，`npm run test:int`）。前端纯逻辑单测放在 `server/test/*.spec.mts`
  （**不引入** jest/vitest）。⚠️ `.mts` spec 由 **Node 原生类型擦除**加载，**装饰器与 JSX 不被擦除**，
  故服务与 `.tsx` 组件**永远**进不了 `.mts`（结构性限制，非配置）；被测模块也**不得新增相对 import**
  （要复用兄弟模块得先开编译选项，收益仅限纯逻辑）。细则与兜底见 [docs/development.md](docs/development.md) §5。

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
cd server && npm test          # node:test 纯函数单测（24 个 spec，无 DB）
cd server && npm run test:int  # DB 集成测试（4 个 spec，需 DATABASE_URL 指向测试库）
```

> **工具与本机操作要点**（判成败看退出码、临时文件别放 `/tmp`、`MSYS_NO_PATHCONV=1`、SSH 推送、
> Prisma 非交互生成迁移、CDP 真渲染细节）见 [docs/development.md](docs/development.md) §9。

## 7. 验收铁律（改完必做，做完才算完工）

1. `cd web && npm run build`、`cd server && npm run build` 均须通过。
   ⚠️ **别用 `grep "error TS"` 判断 `nest build` 成败**（Nest 输出带 ANSI 颜色码，会漏判）：
   看退出码，或直接跑 `npx tsc --noEmit`。
2. `cd server && npm test` 须全绿（24 个 spec，无 DB）——该 job 已进 CI 门禁（`build` 依赖 `test`，红则不发镜像）。
   spec 数量与清单由 `docStats.spec.mts` 锁定，**新增 spec 必须同步 `docs/development.md §5` 清单**。
   **改金额判定 / 状态流转 / 导入相关代码必须另跑 `npm run test:int`**（4 个 spec：金额闸门 / 合同状态流转 /
   导入两阶段 / 招标域投标·评标·定标）——纯函数单测证明不了"闸门是否真的接上了"。
   CI 还会先跑 `prisma migrate diff --exit-code`（改了 schema 没出迁移 → 红）与静态扫描
   `noDbPush.spec.mts`（可执行配置里出现 `db push` → 红）。
3. **重启后端真打一个触发改动的请求**确认不报旧错——只看启动日志不算。
   ⚠️ dev 容器的 `nest start --watch` **不感知宿主机新增/修改的文件**，`dist/` 可能是旧产物
   （接口行为与源码不符）→ 必须 `docker compose -f docker-compose.dev.yml restart server`
   （**不是** `up -d`）；起疑时 `docker exec cms-server-dev grep -c <新符号> /app/dist/src/<路径>.js` 自查。
4. 改过 `schema.prisma` 必须生成并应用迁移，并复查列已落地。
5. 改前端 UI 时**真渲染核一眼**（构建通过发现不了"表头竖排"这类破版）：本机无 Playwright，
   用 Edge headless + CDP 手法，见 [docs/development.md](docs/development.md) §5.2。
6. 修完再验收到通过才完工，不要"改完即报完成"。

## 8. 文档索引

| 文档 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 视觉规则、设计 token、组件样式约定（含 §0 移植/不搬取舍） |
| [TODO.md](TODO.md) | 剩余任务（**只列未完成项**，完成即删除条目） |
| [docs/project-overview.md](docs/project-overview.md) | 项目整体说明（是什么、给谁用、能做什么） |
| [docs/architecture.md](docs/architecture.md) | 架构与数据流 |
| [docs/user-guide.md](docs/user-guide.md) | 面向使用者的功能说明 |
| [docs/development.md](docs/development.md) | 开发方式、命令、测试清单、回归清单 |
| [docs/component-api.md](docs/component-api.md) | 前端组件与后端通用服务的接口 |
| [docs/02-数据库ER设计.md](docs/02-数据库ER设计.md) | 数据模型分区与关系 |
| [docs/03-API接口清单.md](docs/03-API接口清单.md) | REST 接口清单（24 组，含权限码与项目隔离口径） |
| [docs/04-Docker镜像构建与优化.md](docs/04-Docker镜像构建与优化.md) | 单容器镜像构建、踩坑与取舍 |
| [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md) | 四域扩展评估 + 决策记录（含招标域落地增量） |
| [docs/06-变量体系梳理与歧义清单.md](docs/06-变量体系梳理与歧义清单.md) | 采购/合同模板变量两套体系 + 歧义清单 |
| [docs/07-工作域信息关联审计.md](docs/07-工作域信息关联审计.md) | 工作域关联审计（悬空外键、弱关联、核销缺失） |
| [docs/08-全局响应式改造方案.md](docs/08-全局响应式改造方案.md) | 响应式改造方案与实施记录 |
| [docs/09-重构方案评估与采纳建议.md](docs/09-重构方案评估与采纳建议.md) | 外部方案评估 + 现场确认/防超结/招标域落地记录 + 待业务澄清 |
| [README.md](README.md) | 部署与运维（Docker/NAS/CI） |

> **技术选型**：数据库只有 **PostgreSQL 16**（Prisma + 迁移；**禁 `prisma db push`**，CI 有静态与 diff 两道门禁）。
> 以代码与本文档为准。

> **统计数字的两种待遇**：**活文档**（本文件、`docs/development.md`）里的 spec / model / 业务模块 /
> 增量迁移 计数必须与代码一致，由 `docStats.spec.mts` 锁定；**历史报告**（docs/07 §0.1、docs/08 §0.1、
> docs/09 §8 等带日期的记录）是"当时快照"，就地标注即可，**不要**追改。**断言数不进散文**
> （它随用例增减，以 `npm test` 输出为准）。
