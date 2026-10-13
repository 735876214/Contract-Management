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
- 迁移：`server/prisma/migrations/` 下**仅一个折叠基线** `20260901000000_init`（空库 → 当前 schema 一次建全表）。
  改模型用 `npx prisma migrate dev --name xxx` 生成新迁移；**禁止 `prisma db push`**（会让库脱离迁移历史）。
- 启动自动种子（`server/src/seed.ts`，幂等）：`seedAdmin` → `seedDefaultProject` → `seedDictAndParams`，
  数据取自 `server/src/seed-data.ts`（自动生成，勿手改）。CLI 全量演示数据走 `pnpm run seed`（`prisma/seed.ts`）。

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
  改菜单结构后递增 `Sider/utils/storage.ts` 缓存键版本（当前 `_v2`）。

## 项目信息字段（Project 模型）
- 位置/属地类：`provinceCity`(项目所在省市)/`siteLocation`(工程地点)/`projectAddress`(项目地址)/`materialOrigin`(物资产地)；
  均可空文本，编辑在项目管理页表单，列表/导入模板同步。
- 四者同时是采购公共变量 `{{项目所在省市}}/{{工程地点}}/{{项目地址}}/{{物资产地}}` 的数据源
  （链路：项目管理→projectApi.detail→采购页 project state→utils ctx→变量取值表）。
  新增公共变量需同步 5 处（PROCUREMENT_COMMON_VARS + 4 个 utils 文件 + 4 个采购页面）。
- ⚠️ 部门管理已移除：**无独立部门表**，组织维度只有「项目 + 项目内角色」。

## Docker 构建约定
- 发布链路：push main → `.github/workflows/build.yml`（buildx，仅 linux/amd64，GHA 层缓存）→
  **公开** ghcr.io 镜像 `ghcr.io/735876214/cms-single`（tag `latest` + `sha-<sha>`）→ NAS `docker compose pull`。
- 后端 5 阶段：base → deps(全量) → build(dist) → proddeps(`--omit=dev` + prisma CLI + 就地 generate + find 瘦身) → runtime。
  **禁止**再把 build 阶段的整个 node_modules 拷进运行镜像。
- 运行时必须保留 prisma CLI 与 `prisma/` 目录（schema 供启动迁移，`templates/` 是合同模板）。
  安装 prisma CLI 不可带 `--ignore-scripts`（否则无 schema-engine，启动崩）。
- ⚠️ **prisma 是 devDependency，但运行时要用它的 CLI**：`npm install --no-save --omit=dev prisma@^5.10.2`
  **无效**（npm 认为 spec 已被满足，只输出 `up to date`，`.bin/prisma` 不生成，generate 报 127）。
  必须在安装前把它临时挪进 `dependencies` 再 `--omit=dev` 安装；已加 `test -x` 断言。
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

## 验收铁律
改完必做：① `cd web && pnpm run build`（含 `tsc --noEmit`）与 `cd server && pnpm run build`；
② 重启后端**真打一个触发改动的请求**确认不报旧错（只看启动日志不够）；
③ 改过 `schema.prisma` 必须 `npx prisma migrate dev --name xxx` 生成并应用迁移，复查列已落地；
④ 采购阶段链改动跑 `cd server && pnpm test` 验证前后端一致性锁。修完再验收到通过才完工。

> 更完整的回归清单见 `docs/development.md §6`，AI 入门见根目录 `AGENTS.md`。
