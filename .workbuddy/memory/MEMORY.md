# Contract-Management 项目长期记忆

## 仓库与远端
- 远端 `git@github.com:735876214/Contract-Management.git`，主分支 `main`；本地 main 作远端镜像，改完自动 commit+push。
- 远端跟踪引用不持久：`git status` 显示 `gone`；推送前先 `git fetch` 并比对 `git ls-remote origin main` 与 `git rev-parse main` 确认无分叉，再 `git push origin main`。

## 本机环境坑
- bash 缺 coreutils：`export PATH="/c/Users/qingr/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"` 后再跑命令。
- `nest`/`tsc`/`prisma` 的 `.bin` 是 shell 包装脚本，会因 dirname 报错 → 改为 `node node_modules/<pkg>/bin/<x>.js ...` 直接驱动（如 `node node_modules/@nestjs/cli/bin/nest.js build`、`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/prisma/build/index.js ...`）。
- pnpm 入口 `~/.workbuddy/binaries/node/workspace/node_modules/pnpm/pnpm.exe`，安装须带 `--node-linker=hoisted --registry=https://registry.npmmirror.com`；大二进制下载会被截断，必要时复用旧 `node_modules`。vite 启动前删 `web/node_modules/.vite`。

## Prisma 双 schema 与本地数据源（致命坑）
- `schema.prisma`=postgresql，`schema.sqlite.prisma`=sqlite（本地运行时用后者，`server/.env` 为 `DATABASE_URL="file:./dev.db"`）。
- `schema.sqlite.prisma` 由 `scripts/gen-sqlite-schema.js` 从 `schema.prisma` 派生；加/改字段须**两份都改**，再 `prisma db push --schema prisma/schema.sqlite.prisma` + `generate`（`db push` 会顺带重新 generate，故只要保证 `db push` 用的是 sqlite schema 即可，不必再单独 `generate`）。生产迁移 SQL 走 `migrations/<ts>_xxx/migration.sql`（postgres 语法）。
- ⚠️ 已根治「client 反复被覆盖成 postgresql」：2026-09-13 把 `server/package.json` 的 `prisma:generate` 改为 `prisma generate --schema prisma/schema.sqlite.prisma`（保留 `prisma:generate:pg` 给 postgres）。此前 `prisma:generate`（无 --schema）默认指向 postgresql，一旦被 `pnpm install` 的 postinstall 或手动触发，就会覆盖 SQLite client，重启后端报 `Error validating datasource db: the URL must start with postgresql://`。今后跑 generate 直接用 `pnpm prisma:generate`（自带 --schema，无需手带）。
- 默认 `nest build` 后重启后端才生效。

## 新增字段到 Project（已验证套路）
改 `schema.prisma`+`schema.sqlite.prisma` 的 Project 模型 → `db push`(sqlite)+`generate` → `project.service.ts` 的 `PROJECT_FIELDS` 加字段 → 若需进合同模板，在 `template.service.ts` 的 `generate()` 的 `values` 里从 `contract.project.xxx` 取值 → 前端 `web/src/pages/Projects.tsx` 表单与列表列补上。例：2026-09-13 新增 `materialOrigin`(物资产地)，修复采购执行合同模板 `{物资产地}` 占位符此前漏填。

## 采购模块
- 阶段链（后端 `procurement-task.service.ts` 的 `stageChain()` 与前端 `constants/procurementWorkflow.ts` 的 `buildStageChain()` **必须同步改**）：
  `总清单 → [采前会≥100万] → 采购公告 → 采购文件 → 资审报告 → 成交报告 → 价格对比表 → 生成合同`。
- 新增阶段子模块六处：schema 模型(+两侧反引用) → migration.sql(postgres) → service 的 xxx()/saveXxx()/serializeXxx()/publish() 校验 → controller GET+PUT → 前端 `api/modules.ts`+`constants/procurementVariables.ts`（富文本变量用 `h()` 防转义；表格变量 key 含连字符须加引号）→ `utils/<模块>.ts`+页面。
- 状态由 stage 推导（`deriveStatus`），清单类数据不落库、从 `ProcurementTotalItem` 派生。
- ⚠️ 自动关联合同「看不见」坑：`publish()` 终态调 `generateLinkedContract` 生成草稿合同（`status:'DRAFT'`）。合同起草页 `ContractDraft` 的 `draftWhere` 过滤 `createdBy: 当前用户`，而 `contractService.create` 用 `user?.userId` 作 `createdBy`。**必须**把发布人（`@CurrentUser`）透传给 `generateLinkedContract`→`create`；若传 `null`，`createdBy` 为空，起草页永远查不到该合同，现象即「采购任务完成但合同起草里没有推送」。2026-09-13 修复：controller 的 `publish` 注入 `@CurrentUser` 并下传，`generateLinkedContract` 用其 `userId` 作 `createdBy`；存量空 `createdBy` 的 DRAFT 合同已回填 admin。
- 菜单权威来源是后端 `GET /api/menu`（`menu.service.ts` 的 `MENU_TREE`），只改前端 `menuConfig.ts` 无效；菜单 icon 须在 `iconHelper.tsx` 的 `ICON_MAP` 注册；改菜单结构后递增 `Sider/utils/storage.ts` 缓存键版本。

## 项目信息字段（Project 模型）
- 位置/属地类：`provinceCity`(项目所在省市)/`siteLocation`(工程地点)/`projectAddress`(项目地址)/`materialOrigin`(物资产地)；均可空文本，编辑在项目管理页表单，列表/导入模板同步。
- 四者同时是采购公共变量 `{{项目所在省市}}/{{工程地点}}/{{项目地址}}/{{物资产地}}` 的数据源（链路：项目管理→projectApi.detail→采购页 project state→utils ctx→变量取值表）。新增公共变量需同步 5 处（PROCUREMENT_COMMON_VARS + 4 个 utils 文件 + 4 个采购页面）。

## Docker 构建约定
- 发布链路：push main → `.github/workflows/build.yml`（buildx，仅 linux/amd64，GHA 层缓存）→ **公开** ghcr.io 镜像 → NAS `docker compose pull`（`pull_policy: always`）。本地源码验证用 `-f docker-compose.yml -f docker-compose.build.yml`（打 :local，不污染 :latest）。
- 后端 5 阶段：base → deps(全量) → build(dist) → proddeps(`--omit=dev` + prisma CLI + 就地 generate + find 瘦身) → runtime。**禁止**再把 build 阶段的整个 node_modules 拷进运行镜像。
- 运行时必须保留 prisma CLI 与 `prisma/` 目录（schema 供启动 `db push`，`templates/` 是合同模板）。安装 prisma CLI 不可带 `--ignore-scripts`（否则无 schema-engine，启动崩）。
- ⚠️ **prisma 是 devDependency，但运行时要用它的 CLI**：`npm install --no-save --omit=dev prisma@^5.10.2` **无效**（npm 认为 spec 已被满足，只输出 `up to date`，`.bin/prisma` 不生成，generate 报 127）。必须在安装前把它临时挪进 `dependencies` 再 `--omit=dev` 安装；两处均已加 `test -x` 断言。
- 实测镜像（ghcr 压缩层）：cms-backend 115.8MB / cms-frontend 28.4MB。

## Git 操作坑（本机）
- **禁止 `git pull --rebase`**：本环境易被 SIGTERM 中断，会留下 `.git/rebase-merge` 半损状态并丢失对象（本次靠重新 fetch 恢复）。
  改用：`git fetch origin main` → `git update-ref refs/heads/main $(git rev-parse FETCH_HEAD)` → `rm -f .git/index && git reset --mixed HEAD`（工作区不受影响）。
- 查 CI：github.com 走 HTTPS 被代理限制，用 GitHub REST API + PAT 可行；日志接口 302 到 Azure Blob，重定向时需摘掉 Authorization 头。
- 本工作区 `server/src` 有 11 个文件停留在 `e27a1b1` 旧版本（远端 `0c66afa` 是别处提交的新版），`git status` 会显示「改动」，实际是旧内容，勿误提交。
- ⚠️ 镜像体积=各层之和： running 阶段新开 `RUN rm -rf` 不会变小，清理必须放在被 COPY 的中间阶段内。
- 公开镜像 ⇒ `.dockerignore` 必须排除 `.env`/`.env.*`，别把 JWT_SECRET 发到公网。
- 详见 `docs/04-Docker镜像构建与优化.md`；未采用 alpine/distroless/pnpm 的理由亦在其中。

## 验收铁律
改完必做：① `web tsc --noEmit`、`server nest build`；② 重启后端真打一个触发改动的请求确认不报旧错（只看启动日志不够）；③ 改过 schema 必须 `db push`(sqlite) 并用 `PRAGMA table_info(<表>)` 复查列落地；④ 前端改必要 `vite build`。修完再验收到通过才完工。

## 未纳入版本控制
- `server/src/common/utils/chinese-amount.ts`（未跟踪，勿删）。
