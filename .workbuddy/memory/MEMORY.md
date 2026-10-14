# Contract-Management 项目长期记忆

> **2026-10-13 校准**：本文件此前停留在 2026-09 中旬，若与代码冲突**以代码为准**。
> 本次已删除/修正：「Prisma 双 schema（sqlite）」「资审报告阶段」「部门管理」等失效结论。
> 更完整的项目文档见仓库根的 `AGENTS.md`、`DESIGN.md`、`TODO.md` 与 `docs/`。

## 仓库与远端
- 远端 `git@github.com:735876214/Contract-Management.git`，主分支 `main`；本地 main 作远端镜像，改完自动 commit+push。
- 远端跟踪引用可能不持久（`git status` 显示 `gone`）；推送前先 `git fetch` 并比对 `git ls-remote origin main` 与 `git rev-parse main` 确认无分叉，再 `git push origin main`。

## 数据库（**重要：已收敛为 PostgreSQL 单 schema**）
- 2026-09-17（`96b6055`）起，**只有 `server/prisma/schema.prisma`（provider = postgresql）**。
  历史上曾存在的 `schema.sqlite.prisma`、`scripts/gen-sqlite-schema.js`、双 schema 维护方式**已删除**。
- `server/package.json` 的 `prisma:generate` = `prisma generate`（无 `--schema`，指向唯一 schema）；
  `prisma:deploy` = `prisma migrate deploy`。
- 迁移：`server/prisma/migrations/` 下 **`20260901000000_init`（折叠基线，空库→当前 schema 一次建全表）**
  + **`20261014000000_p1_consistency`**（死字段清理、12 个关键外键、收领单↔日报外键、变量改名回填；
  **加外键前必须先在同一迁移内做数据清洗**，见该文件头注释）。
  改模型用 `npx prisma migrate dev --name xxx` 生成新迁移；**禁止 `prisma db push`**（会让库脱离迁移历史）。
- 启动自动种子（`server/src/seed.ts`，幂等）：`seedAdmin` → `seedDefaultProject` → `seedDictAndParams` → `fixLegacyData`
  （最后一个是 2026-10 加的「历史数据修正」入口：改缺陷数据请加在这里，**不要改已应用的迁移文件**——会与
  `_prisma_migrations` 的 checksum 冲突、`migrate deploy` 直接失败）。
  数据取自 `server/src/seed-data.ts`（自动生成，勿手改）。CLI 全量演示数据走 `npm run seed`（`prisma/seed.ts`）。

## 采购模块
- 阶段链（后端 `server/src/constants/procurementFlow.ts` 的 `stageChain()` 与前端
  `web/src/constants/procurementWorkflow.ts` 的 `buildStageChain()` **必须同步改**，
  由 `server/test/frontendChainParity.spec.mts` 锁定一致性）：
  - SINGLE 单项采购：`总清单 → [采前会≥100万] → 采购公告 → 采购文件 → 成交报告 → 价格对比表 → 生成合同`
  - FRAMEWORK 框架协议：`总清单 → 价格对比表 → 框架协议事前说明 → 生成合同`
  - EMERGENCY 紧急采购：`总清单 → 生成合同`
  - ⚠️ 「**资审报告**」阶段**已移除**（旧记忆有误）；`InspectionReport`（考察报告）是**独立模块**，不在阶段链中。
- 新增阶段子模块需同步改**六处**：`schema.prisma`（+两侧反引用）→ 迁移 SQL → service
  （`xxx()/saveXxx()/serializeXxx()/publish()` 校验）→ controller（GET+PUT）→ 前端
  `api/modules.ts` + `constants/procurementVariables.ts`（富文本变量用 `h()` 防转义；表格变量 key 含连字符须加引号）
  → `utils/<模块>.ts` + 页面。
- 状态由 stage 推导（`deriveStatus`），清单类数据不落库、从 `ProcurementTotalItem` 派生。
- ⚠️ 自动关联合同「看不见」坑：`publish()` 终态调 `generateLinkedContract` 生成草稿合同（`status:'DRAFT'`）。
  合同起草页按 `createdBy: 当前用户` 过滤，**必须**把发布人（`@CurrentUser`）透传下去当 `createdBy`；
  传 `null` 会导致「采购任务完成但合同起草里没有推送」。2026-09-13 已修复。
- 菜单权威来源是后端 `GET /api/menu`（`server/src/modules/system/menu.service.ts` 的 `MENU_TREE`），
  只改前端 `menuConfig.ts` 无效；菜单 icon 须在 `iconHelper.tsx` 的 `ICON_MAP` 注册；
  改菜单结构后递增 `Sider/utils/storage.ts` 缓存键版本（当前 `_v3`）；
  ⚠️ 缓存键带版本后缀，**清缓存必须走 `clearMenuCache()`**——`logout()` 曾写死无版本的旧键名，
  导致切换账号后最长 5 分钟仍显示上一账号的菜单树（2026-10 已修）。

## 项目信息字段（Project 模型）
- 位置/属地类：`provinceCity`(项目所在省市)/`siteLocation`(工程地点)/`projectAddress`(项目地址)/`materialOrigin`(物资产地)；
  均可空文本，编辑在项目管理页表单，列表/导入模板同步。
- 四者同时是采购公共变量 `{{项目所在省市}}/{{工程地点}}/{{项目地址}}/{{物资产地}}` 的数据源。
- ⚠️ **字段名有两套，极易踩**：`/projects/:id` 返回 Project 原始记录（`name`/`nameAbbr`/`code`/
  `materialOrigin`），而采购文档上下文用 `projectName`/`projectAbbr`/`projectCode`/`materialOrigin`，
  映射在 `web/src/utils/procurementTaskDocs.ts` 的 `baseCtx`。曾按旧名读取 → 导出文档项目信息**全为空**。
  新增公共变量：`PROCUREMENT_COMMON_VARS` + **6 个** `utils/procurement*.ts` 取值表 + `preMeetingMinutes.ts`
  + `baseCtx`；漏一处会被 `server/test/procurementVariables.spec.mts` 的「公共变量取数为空」用例拦下。
- ⚠️ 部门管理已移除：**无独立部门表**，组织维度只有「项目 + 项目内角色」。

## Docker 构建约定
- 发布链路：push main → `.github/workflows/build.yml`（buildx，仅 linux/amd64，GHA 层缓存）→
  **公开** ghcr.io 镜像 `ghcr.io/735876214/cms-single`（tag `latest` + `sha-<sha>`）→ NAS `docker compose pull`。
- 后端 5 阶段：base → deps(全量) → build(dist) → proddeps(`--omit=dev` + prisma CLI + 就地 generate + find 瘦身) → runtime。
  **禁止**再把 build 阶段的整个 node_modules 拷进运行镜像。
- 运行时必须保留 prisma CLI 与 `prisma/` 目录（schema 供启动迁移，`templates/` 是合同模板）。
  安装 prisma CLI 不可带 `--ignore-scripts`（否则无 schema-engine，启动崩）。
- ✅ **prisma 已正式归入 `dependencies`**（2026-10）：运行时需要它的 CLI 跑 `migrate deploy`，
  归入 dependencies 后 `npm ci --omit=dev` 直接可用，Dockerfile 里「临时把 prisma 挪进 dependencies
  再 --omit=dev」的老 hack 已删除；保留 `test -x ./node_modules/.bin/prisma` 断言。
- 体积经验：镜像体积=各层之和，runtime 阶段新开 `RUN rm -rf` 不会变小，清理必须放在被 COPY 的中间阶段内。
- 公开镜像 ⇒ `.dockerignore` 必须排除 `.env`/`.env.*`，别把 JWT_SECRET 发到公网。
- 本地源码构建请用 `docker compose up -d --build`（compose 已内置 `build:` 段）。
  > 旧记忆提到的 `docker-compose.build.yml` 覆盖层**已不存在**。
- 详见 `docs/04-Docker镜像构建与优化.md`（2026-10 补写）。

## Git 操作坑（本机）
- **禁止 `git pull --rebase`**：本环境易被 SIGTERM 中断，会留下 `.git/rebase-merge` 半损状态并丢失对象。
  改用：`git fetch origin main` → `git update-ref refs/heads/main $(git rev-parse FETCH_HEAD)` →
  `rm -f .git/index && git reset --mixed HEAD`（工作区不受影响）。
- 查 CI：github.com 走 HTTPS 被代理限制时，用 GitHub REST API + PAT 可行；
  日志接口 302 到 Azure Blob，重定向时需摘掉 Authorization 头。
- **推送只能走 SSH**（2026-10-14 实测）：本机对 GitHub 是**分通道**放行的 —— HTTPS 的 **GET 正常**
  （`git ls-remote`/`git fetch`/`curl https://api.github.com` 都通），但 HTTPS 的 **POST 被阻断**
  （`git push` 报 `Failed to connect to github.com port 443`），`curl https://github.com` 也连不上；
  **SSH 通道（`git@github.com`，含 `ssh.github.com:443`）认证与推送均正常**。
  而当前 `origin` 是 HTTPS 地址，所以 **`git push origin main` 必定失败**，要显式用：
  `git push git@github.com:735876214/Contract-Management.git main`
  （或用 `git remote set-url origin git@github.com:735876214/Contract-Management.git` 一次性改掉）。

## 验收铁律
改完必做：① `cd web && npm run build`（含 `tsc --noEmit`）与 `cd server && npm run build`；
② `cd server && npm test`（11 个 spec / 151 项断言，**CI 门禁**：`.github/workflows/build.yml` 的
   `test` job，`build` job `needs: test`，测试红则不发布新镜像）；
③ 重启后端**真打一个触发改动的请求**确认不报旧错（只看启动日志不够）；
④ 改过 `schema.prisma` 必须 `npx prisma migrate dev --name xxx` 生成并应用迁移，复查列已落地。
修完再验收到通过才完工。

> 更完整的回归清单见 `docs/development.md §6`，AI 入门见根目录 `AGENTS.md`。

## 2026-10-13 批次：成因与易错点（约定见 AGENTS.md）

> 本节记「为什么是这样」，硬约定写进 `AGENTS.md` §4/§5，剩余任务见 `TODO.md`（完成即删除）。

- **依赖管理：pnpm → npm（已统一，勿回退）**
  - 症状：镜像已构建成功但依赖每次重新解析、不可复现。
  - 成因：`package.json` 声明 `packageManager: pnpm@12.3.4` 且留有 `pnpm-lock.yaml`，但
    **镜像与 CI 实际走 npm**，而 `.gitignore` 又明确排除了 `package-lock.json`
    （旧注释写着"本项目使用 pnpm 锁定依赖"）→ npm 这条路根本没有锁文件；且 `pnpm-lock.yaml`
    已过期（`package.json` 09-17 改过、锁文件停在 09-14）。
  - 处置：生成并入库两个 `package-lock.json`、移除 `.gitignore` 排除规则、删除
    `pnpm-lock.yaml`/`pnpm-workspace.yaml`/`packageManager` 字段，镜像 + CI + dev compose 全改
    `npm ci --legacy-peer-deps`。
  - 不给 pnpm 留活口的原因：镜像内曾评估 pnpm，因**符号链接跨构建阶段 COPY 易踩坑**而放弃
    （见 `.workbuddy/memory/2026-09-13.md`），所以统一到 npm 一侧而不是统一到 pnpm。

- **合同台账 42 列「表头竖排」（桌面端也破版）**
  - 成因：`LEDGER_COLUMNS[].width` 是 **Excel 字符宽（8~30）**，前端 `Ledger.tsx` 直接当**像素**
    传给 antd → 每列 8~30px，中文字段名被压成竖排文字。
  - 处置：换算集中到 `server/src/modules/ledger/ledger-columns.ts` 的 `ledgerColumnWidthPx()`
    （≈8px/字符、100px 下限）并在 API 边界输出像素；台账冻结前两列。契约由
    `server/test/ledgerColumns.spec.mts` 双向锁定（既防"字符宽当像素"，也防有人把原始值改成像素）。
  - 注：同文件下方的**导出**列定义（`{ header, key, width: 110~240 }`）是**另一份**定义，
    与前端表格无关，改一处不影响另一处。
  - 教训：这个缺陷是**用 Edge 截图看出来的**，构建通过与单测都发现不了。

- **采购变量：金额单位与旧名兼容**
  - 症状：同一 `{{预计采购金额}}` 在采前会（万元）与成交报告（元）单位不同 → 文档金额可能差 10000 倍。
  - 处置：变量名带单位后缀（`(万元)`/`(元)`）、旧名进 `PROCUREMENT_VAR_ALIASES` 单向兼容
    （别名沿用规范名的取值与「是否转义」注入方式）；存量模板正文由迁移回填。
  - 另修两处：采前会曾用「技术质量要求/验收标准/付款条件」与公告侧异名；`INITIATE` 定义了 3 个
    变量却永不替换（采购发起不产出 Word，已清空）。
  - 变量体系全貌与 8+3 项缺陷清单见 `docs/06`（§0.1 是修复记录）。

- **采购任务 ↔ 合同：双写 → 单条表达**
  - 原先 `ProcurementTask.contractId` 与 `Contract.taskId` 双写；已删前者，关联只由 `Contract.taskId` 表达。
  - **主合同 = 该任务最早创建的合同**（同批生成时再按编号排序）；任务详情的 `contractId` 为派生值。
  - ⚠️ `GET /contracts` 列表按 `createdAt DESC`，`list[0]` 是**最后**创建的那份，拿它当主合同会写错断言
    （E2E 踩过，已修）。

- **响应式：现状与取舍**
  - 断点唯一来源 `web/src/hooks/useResponsive.ts`（首帧按桌面处理避免闪动）；`<768` 侧栏自动变 Drawer
    （选中菜单自动关闭）；`BasicLayout` 折叠状态沿用本地持久化值。
  - 全站表格补 `scroll`、固定 `Col span` 清零、弹窗宽度由 `index.css` 全局 `max-width: calc(100vw - 16px)` 兜底。
  - **大宽表（36 列台账）不卡片化**是明确取舍，不是遗漏；详见 `DESIGN.md` §10 与 `docs/08` §0.1。
  - 未做：编辑器工具栏"更多"是**展开式**而非下拉（工具栏含 Select/Popover，塞进菜单项交互不稳）。

- **前端工程化现状**：路由级权限守卫（`RequirePermission` + `constants/routePermissions.ts`）+ 全量
  `React.lazy`；旧扁平路径一律 `<Navigate replace>` 重定向（`/contracts` 除外，见 TODO）。
  三者的一致性由 `server/test/routePermissionParity.spec.mts` 锁定。

- **本机验收手法（无浏览器自动化依赖）**
  - 起栈：`docker compose -f docker-compose.dev.yml up`（前端 5173 / 后端 3000 / PG 15432）。
  - 端到端：`node scripts/e2e-procurement-flow.mjs`（**84 项断言**，走 5173 前端代理，会写数据）。
  - 真渲染核验：本机**没有 Playwright/Puppeteer**，用 `msedge --headless=new --remote-debugging-port`
    + CDP（Node 内置 `WebSocket`）切视口、注 `localStorage.cms_token`、截图后再看图。
  - `GET /api/ledger/contracts` 等接口可用 admin/admin123 + `x-project-id` 直接 curl 校验取数。

## 2026-10-14 批次：外部重构方案评估 + 现场确认 / 防超结（约定见 AGENTS.md §4）

- **评估结论**：用户给的两份"以合同为聚合根"重构方案**同源**（详略不同）、**未读过本仓库代码**
  （通篇"可能/建议 ensure"）。逐项对照后：约 1/3 主张**本项目已实现**（合同为聚合根、`ContractMaterial`
  即清单项、台账实时聚合不落库、合规问题自动算、不冗余累计金额字段、PG 锁定、变更留痕…）；
  **4 项与既有决策冲突**（付款三级模型回退 / 数据库枚举 / Flowable·物化视图 / 供应商快照语义）；
  真正缺口 8 项。完整评估见 `docs/09`（§7 是 4 条待业务澄清项，已同步进 TODO）。
  **一句话**：不要照它的路线图重建模型，只需补"现场确认 → 结算 → 付款"这条主线的闸门与上限。

- **现场确认的落点选择**：**不建 `SiteRecord` 本体**——日报行（`DailyReport`）就是现场记录的落点
  （收领单推送也生成日报行），确认只需落在这一层即可用一个闸门覆盖两个来源。若将来有人要"独立的
  现场记录表"，先想清楚这点，否则会与日报/收领单重复建模。

- **口径开关的用法（重要）**：`settlement.require_confirmed`（默认 true）是**行为开关**——
  开启后新日报默认「待确认」，未确认不计入结算口径；存量已回填为「已确认」避免归零。
  上线/回退只需改这个参数（`PUT /system/params`，`SysParamService` 有缓存、保存时会 refresh）。

- **日报页字段名坑（已修，勿再犯）**：`web/src/pages/DailyReports.tsx` 的 `FIELDS` **同时驱动表格列与表单字段**，
  历史上其中 10 个 key 与模型不一致（`dept` vs `department`、`standardTotal` vs `stdAmount` …）
  → 表格 10 列空白 + **保存必定 500**（Prisma 拒绝未知字段）。用真实请求复现后才定位到。
  教训：这类"UI 字段名 ↔ 模型字段名"错配**编译期抓不到**，改动该数组后必须真打一次保存请求。

- **`supplier.name.sync.history` 是悬空参数**：系统参数里声明了「供应商改名时历史合同 KEEP/SYNC」，
  但**全仓无读取点、从未实现**；配合"合同模板导出取供应商实时数据"，意味着主数据一改、
  历史合同**再导出**的内容就变了。这正是外部方案提"供应商快照"的真实动因（待业务澄清，见 TODO）。

- **防超结/防超付的取舍**：默认策略 `WARN`（不阻断生产），确认后再切 `BLOCK`；
  草稿结算不校验、付款"失败/退款"不计入累计——这几处都是有意的，改动前先看 `docs/09` §8。
