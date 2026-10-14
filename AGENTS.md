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
│   ├── 01~09-*.md       # 需求摘要/ER/接口清单/Docker/四域扩展/变量体系/关联审计/响应式/重构评估
│   └── project-overview.md architecture.md user-guide.md development.md component-api.md
├── server/              # NestJS 后端
│   ├── prisma/schema.prisma        # 全量数据模型（52 个 model）
│   ├── prisma/migrations/          # 折叠基线 20260901000000_init + 6 个增量迁移
│   │                               #   （p1_consistency / site_confirmation / scrub_log_secrets
│   │                               #    / import_task_recovery / canonicalize_template_placeholders
│   │                               #    / tender_bidder_and_evaluation）
│   ├── prisma/seed.ts  src/seed.ts  src/seed-data.ts
│   ├── src/common/     # 通用层：统一响应/异常/装饰器/Excel/导入/日志/系统参数
│   ├── src/constants/  # procurementFlow.ts（采购工作流单一事实源）、workflowGuards.ts
│   ├── src/modules/    # 22 个业务模块
│   ├── test/           # node:test 纯函数单测（23 个 spec，无 DB；清单见 docs/development.md §5）
│   └── test-integration/ # DB 集成测试（4 个 spec，需 PostgreSQL：npm run test:int）
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
4. **字典驱动 + code 单一事实源**：所有下拉/标签/颜色来自 `dict_type`/`dict_item`，业务表存**字典项编码字符串**
   （不用数据库枚举）。前端用 `DictSelect`/`DictTag`，后端用 `dict.service` 校验。
   **但 code 本身不许各处裸写**：核心状态码的单一事实源是
   `server/src/constants/statuses.ts`（合同/结算/付款/发票/现场确认/执行情况…）与
   `server/src/constants/procurementFlow.ts`（采购任务状态 `TASK_STATUS`、五态合同类型 `CONTRACT_TYPES`），
   service 里写 `SETTLEMENT_STATUS.DRAFT` 而不是 `'DRAFT'`；字典 typeCode 用 `DICT_TYPES.*`。
   两侧由 `server/test/statusCodes.spec.mts` **双向锁死**（常量 ↔ 字典项 ↔ `schema.prisma` 的 enum）。
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
  - **执行期有心跳、崩溃可回收**：`execute()` 写 `lockedAt` 并随进度刷新；启动时与每 5 分钟巡检一次
    （`reapStaleTasks()`，纯判据 `isImportTaskStale()`），把超过 10 分钟无心跳的 PENDING/RUNNING 任务置为
    FAILED（提示重新导入）——此前进程崩溃会**永久卡在进行中**。
  - **幂等去重**：同一份文件（`模块+文件名+行数+内容摘要` 的 sha1）在 PENDING/RUNNING 期间重复提交时
    复用既有任务；`submit()` 用 PG **事务级咨询锁**串行化同键提交（双击就是并发，"先查后建"会双开）。
    ⚠️ 去重命中后**绝不能再跑一次 execute**（两次并发写同一批数据 → 后者撞唯一约束，任务被误置 FAILED）。
- **写字段白名单**：service 用 `common/pick-fields.ts` 的 `pickFields` 过滤未知字段，防前端字段漂移 500。
- **日志必须脱敏（白名单）**：操作日志拦截器会把「请求参数 + 变更前后快照」整体写入 `OperationLog`
  （日志页仅需 `system:user` 权限即可查看），**凭据/银行账号/证件号/联系方式不得明文入库**。
  打码规则集中在 `common/utils/mask.ts`（`slimSecrets()` 深拷贝后按键名打码，**不改原对象**——
  入参可能是即将返回给前端的响应体）。新增敏感字段须登记进 `SECRET_FIELD_KEYS`；
  契约由 `server/test/mask.spec.mts` 锁定。历史遗留明文（35 条 JWT / 银行账号 / 证件号）
  已由迁移 `20261016000000_scrub_log_secrets` 一次性清洗。
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
  ⚠️ **合同链未填金额时返回 `null` = 无上限**（不可校验）：不要把「无金额」当成上限 0，
  否则任何一笔结算/付款都会被误判超限（BLOCK 下直接拦住合法单据）。
  注：清单项级「结算量 ≤ 已确认量」的量级校验**尚未做**（需先定变更口径，见 docs/09 §7）。
- **采购总清单会带入合同起草清单**：任务全部阶段发布后自动生成合同时，
  `generateLinkedContract()` 会把 `ProcurementTotalItem` 带入该合同的**起草期清单**
  （`ContractDraftMaterial`）：`qty ← qty`、`priceBeforeTax ← planPrice`（控制价）、`unit ← unit`；
  税率按**合同主表税率**预填、含税单价与暂定含税合价服务端重算（与 `draftSave` 同口径）。
  多单位场景**每份合同都带入同一份清单**（由用户按成交单位裁剪）；带入失败只记日志、**不阻断**合同生成。
  写入口：`contract.service.seedDraftFromProcurementItems()`（幂等，已存在的物资跳过）。
- **招标域：结构化行是事实源，JSON 只是发布快照**（2026-10-19，迁移 `20261019000000_tender_bidder_and_evaluation`）。
  1. **导入双写**：导入「响应单位情况汇总表」时，同一事务内既写 `ProcurementResultReport.suppliers`（JSON 快照，
     发布文档口径不变）又写 `ProcurementBidder` 结构化行（唯一键 `(taskId, bidderName)`）。
     **单位与两轮报价以导入表为准**，面板只维护「状态 / 投标文件 / 最终确认价 / 备注」四项。
  2. **定标 = 勾选「拟推荐成交候选人」**：服务端把勾中的单位置为 `WON` 并写 `finalPreTaxTotal`；
     取消勾选回落「入围（通过第一轮）/ 已递交」（纯函数 `bidderStatusWhenNotWon()`）。
     ⚠️ **生成合同的单位与金额只从结构化中标行取**（`candidatesFromBidders()` → `resolveContractUnits()`），
     **别改回读 JSON `candidates`**——快照可能过期；`test-integration/tender-bidders.int.spec.ts` 有一条
     「刻意篡改快照也不采信」的判据挡着。
  3. **存量回填**由 `ensureBiddersFromSnapshot()` 在首次读取/生成合同时**幂等**完成（不写一次性迁移脚本）；
     重新导入时**有评标记录的单位拒绝删除并报错**（静默丢评估数据比报错更糟）。
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
- **合同模板占位符只认双花括号**：`{{变量名}}`（表格占位符 `{{物料编码清单}}` / `{{合同清单}}` 同类），
  渲染是零依赖纯函数 `server/src/modules/template/template-render.ts`（`renderTemplate()`），
  由 `server/test/templateRender.spec.mts` 锁死。**单花括号 `{变量名}` 与英文遗留 key
  （`MATERIAL_CODE_TABLE`/`CONTRACT_ITEM_TABLE`）的支持已移除**（2026-10-14，项目无存量业务数据；
  旧写法还会误伤富文本里的 CSS 花括号）——别再加回兼容分支，也别把新模板写成单花括号。
  改语法或改种子模板 `server/prisma/templates/*.ts` 后，须重跑
  `npx ts-node prisma/templates/upsert-purchase-exec.ts`（已是真 upsert，会刷新内容）。
  ⚠️ **种子模板有两处，别只改一处**：`prisma/templates/*.ts`（独立文件）**和 `prisma/seed.ts` 里内联的
  3 份**（空库 + `npm run seed` 才创建，改动当时不可见——2026-10-14 正是漏了后者导致新环境 seed 出的
  模板残留 `{合同名称}` 之类裸占位符）。两道防线：`templatePlaceholderSyntax.spec.mts`（源码扫描 + 渲染无残留）。
- **文件落盘只有一条路：`common/services/storage.service.ts`**（`StorageService`）。上传 / 合同签章件 /
  导入错误报告这 3 处写入点已全部收敛过去，**不要再在 service/controller 里自己拼 `UPLOAD_DIR` 与文件名**；
  键是**相对 POSIX 路径**（`signed/x.pdf`，用 `/` 不用 `path.join`，否则 Windows 下落库成 `signed\x.pdf`），
  对外 URL = `/api/files/<键>`（`publicUrl()`）。越权键（`..`/绝对路径）一律 400。
  纯逻辑在 `common/utils/storage-keys.ts`（`server/test/storageKeys.spec.mts` 锁定）。
  ⚠️ multer 的 `destination/filename` 回调在**类定义期**求值，`this` 不是控制器实例——别在那里注入式取服务。
  切对象存储时只需实现同一个 `StorageLike` 并改 `common.module.ts` 的 provider 绑定，
  另需把 `main.ts` 的 `useStaticAssets` 改为代理/重定向。
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
- **视觉 token 只有一处来源**：`web/src/theme.ts`（JS 侧色板/语义色/图表配色）+ `web/src/index.css`
  的 `--cms-*`（CSS 镜像）+ `components/Sider/index.less`（深色侧栏，LESS 不能用 `var()`）。
  **页面/组件里不许写死 `#hex` / `rgb()`**——由 `server/test/themeTokens.spec.mts` 锁定，
  白名单仅 `RichTextEditor.tsx`（编辑器调色板是功能）与 `utils/docExport.ts`（Word 内联样式）。
  状态色**不重命名**（字典与 `TASK_STATUS_COLORS` 里是 `blue/green/orange…` 这类语义名，且是前后端镜像），
  换视觉在渲染层做：`theme.PRESET_TONE_MAP` + index.css 的 `.ant-tag.ant-tag-<name>` 覆盖。
  改视觉前读 [DESIGN.md](DESIGN.md)（§0 写了移植了什么、不搬什么，含"不搬 Anthropic 商标"）。
- **断点唯一来源是 `useResponsive()`**（`web/src/hooks/useResponsive.ts`）：**禁止**组件内使用
  `window.innerWidth` / `matchMedia`。具体规格（`isMobile(<768)`）、四条硬性约定（Col 带断点、
  Table 声明 `scroll`、弹窗宽度可被全局兜底、≤md 侧栏走 Drawer）与明确取舍见
  [DESIGN.md](DESIGN.md) §10。
- **列表页列显隐有两条互不相同的路**：① 通用列表页 `ModuleListPage` 的 `columnConfigKey`（偏好存
  **localStorage**，纯逻辑在 `web/src/utils/listColumns.ts`，由 `server/test/listColumns.spec.mts` 锁），
  ② 合同台账 `Ledger` 的 `ledger.columns.config`（**服务端共享**配置，页面列也由后端返回）。
  **别混用**：给台账页再传 `columnConfigKey` 会出现两套列设置打架；列显隐**不落 `sys_param`**
  （那是全局配置且需 `system:config` 权限，普通用户存不了）。
- **两套测试，别混用**：`server/test/*.spec.*`（纯函数/漂移锁，**无 DB、秒级**，随 `npm test`）与
  `server/test-integration/*.int.spec.ts`（真库，`npm run test:int`）。前者只允许 import
  **无相对运行时依赖**的模块（`.mts` 由 Node 原生擦除类型加载，ESM 不做扩展名推断）；后者是 `.ts`，走 ts-node。
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
cd server && npm test          # node:test 纯函数单测（23 个 spec，无 DB）
cd server && npm run test:int  # DB 集成测试（4 个 spec，需 DATABASE_URL 指向测试库）
```

完整清单见 [docs/development.md](docs/development.md)。

## 7. 验收铁律（改完必做，做完才算完工）

1. `cd web && npm run build`（含 `tsc --noEmit`）、`cd server && npm run build` 均须通过。
   ⚠️ **别用 `grep "error TS"` 判断 `nest build` 成败**：Nest 的输出带 ANSI 颜色码，grep 会漏判
   （2026-10-14 实测：`nest build` 看着"通过"，`npx tsc --noEmit` 才暴露 3 处类型收窄错误）。
   要么看命令退出码，要么直接跑 `npx tsc --noEmit`（平文输出）。
2. `cd server && npm test` 须全绿（23 个 spec，**无 DB 依赖**）——该 job 已进 CI 门禁，
   `.github/workflows/build.yml` 的 `build` 依赖 `test`，**测试红则不发布新镜像**。
   断言数不写在这里（它随用例增减，以命令输出为准）；spec 数量与 `docs/development.md §5` 清单
   由 `server/test/docStats.spec.mts` 锁定，**新增 spec 必须同步登记清单**。
   另有一套 **DB 集成测试** `cd server && npm run test:int`（4 个 spec：金额闸门 / 合同状态流转 /
   导入两阶段 / 招标域投标·评标·定标，需 `DATABASE_URL` 指向库名含 `test`/`int` 的测试库，见 docs/development.md §5.2）；
   **改金额判定、状态流转、导入相关代码时必须跑它**（纯函数单测证明不了"闸门是否真的接上了"）。
   CI 同样会跑（postgres service），且会先跑 `prisma migrate diff --exit-code`：
   **改了 `schema.prisma` 却没生成迁移 → 红**；可执行配置里出现 `db push` 也会红（`test/noDbPush.spec.mts`）。
3. **重启后端真打一个触发改动的请求**确认不报旧错——只看启动日志不算。
   ⚠️ dev 容器（`docker-compose.dev.yml`）的 `nest start --watch` **不感知宿主机新增/修改的文件**
   （bind mount 不转发变更事件）→ `dist/` 可能是**旧编译产物**，接口行为与源码不符
   （2026-10-14 实测：新增的 `common/utils/overdue-summary.ts` 没进 dist，一度被误判成"逻辑没生效"）。
   所以必须 `docker compose -f docker-compose.dev.yml restart server`（**不是** `up -d`：容器已在运行时
   它既不重编译也不重跑 `migrate deploy`）；起疑时用
   `docker exec cms-server-dev grep -c <新符号> /app/dist/src/<路径>.js` 自查是否在跑旧代码。
4. 改过 `schema.prisma` 必须生成并应用迁移，并复查列已落地。
5. 改前端 UI 时**真渲染核一眼**（构建通过发现不了"表头竖排"这类破版）；
   本机无 Playwright，用 Edge headless + CDP 手法，见 [docs/development.md](docs/development.md) 的「前端真渲染核验」小节。
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

> **技术选型一句话**：数据库只有 **PostgreSQL 16**（Prisma + 迁移，**禁 `prisma db push`**，
> CI 有静态与 diff 两道门禁）。历史上存在过 **SQLite 演示变体与双 schema**（`schema.sqlite.prisma`
> 配合 `db push` 跑本地库），已于 **2026-09-17 整体移除**——相关记忆与操作指引也于 2026-10-14 删除，
> **勿再引入**（看到任何 sqlite/双 schema 的说法，都是过时信息）。
> 同样已移除的还有「资审报告」阶段。以代码与本文档为准。

> **统计数字的两种待遇（2026-10-14 定）**：
> **活文档**（本文件、`docs/development.md`）说的是"现在是什么"，其中的 spec / model / 业务模块 /
> 增量迁移 计数**必须与代码一致**，由 `server/test/docStats.spec.mts` 锁定——新增 spec 要同步
> `docs/development.md §5` 的清单，新增迁移要同步本文件 §2 的迁移列表；
> **历史报告**（`docs/07` §0.1、`docs/08` §0.1、`docs/09` §8 等**带日期的实施/验收记录**）说的是
> "当时是什么"，就地标注「当时快照」即可，**不要**为了"看起来新"去追改（改了等于篡改记录）。
> **断言数（如"253 项断言"）不进散文**：它随每次加/改用例变动，以 `npm test` 输出为准。
