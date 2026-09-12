# Contract-Management 项目长期记忆

## 仓库与远端
- 远端：`git@github.com:735876214/Contract-Management.git`，主分支 `main`。
- 本地 `main` 长期作为远端镜像使用，不做本地独立提交。

## 本机 Git 环境注意事项（重要）
- **远端跟踪引用不持久**：`git fetch` 后 `refs/remotes/origin/main` 在本环境中不会被保留，
  `git status` 会一直显示 `## main...origin/main [gone]`，`git pull` 无法直接使用。
  - 正确做法：`git fetch origin main && git merge --ff-only FETCH_HEAD`
  - 如需修复上游引用：`git update-ref refs/remotes/origin/main FETCH_HEAD`
- **bash 的 PATH 缺少 coreutils**：`ls`/`cat`/`head`/`dirname`/`rm` 等会报 command not found。
  - 解决：在命令前加 `export PATH="/c/Users/qingr/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"`
- Bash 工具存在 stdout 不回显的情况，可将输出重定向到文件后用 Read 读取。

## 代码结构
- `server/` NestJS + Prisma（`server/prisma/schema.prisma` 与 `schema.sqlite.prisma` 双份）
- `web/` React + Vite，页面在 `web/src/pages/`，业务组件在 `web/src/components/`
- 采购管理模块：`server/src/modules/procurement/`、`web/src/pages/Procurement/`
- 包管理器已统一为 pnpm。

## Prisma 双 schema 的坑（重要）
- `schema.sqlite.prisma` 是 `scripts/gen-sqlite-schema.js` **从 `schema.prisma` 派生**的，别手工改 sqlite 那份。
- 历史遗留：任务 3.1 只给 `schema.sqlite.prisma` 手工补了 `Project.frameworkExplanations`，漏改 `schema.prisma`，
  导致 `schema.prisma` 校验失败（缺反引用）。已于任务 3.2 修复，两份已一致。
- 加模型时务必**同时**确认两侧关系字段齐全，然后走：`gen-sqlite-schema.js` → `db push` → `generate`。
- 生产迁移 SQL 按 `migrations/<timestamp>_<name>/migration.sql` 追加（PostgreSQL 语法），本地 SQLite 不用跑。

## 采购模块已实现范围
- 任务 2.1 采购发起 + 工作流状态（`ProcurementTask`，阶段链由 `stageChain()` 推导）
- 任务 2.2 总采购清单（`ProcurementTotalItem`，含基础库/字典/控制价校验）
- 任务 3.1 框架协议事前说明（`FrameworkExplanation`，仅 FRAMEWORK 类型）
- 任务 3.2 采前会会议纪要（`PreMeetingMinutes`，仅 SINGLE 且预计采购金额 ≥ 100 万；
  预计采购金额 = Σ 控制价×暂定数量；发布总清单时自动判定 `preMeetingRequired`）
- 任务 3.3 采购公告（`ProcurementNotice`，仅 SINGLE；采购清单不落库、始终从 `ProcurementTotalItem`
  派生保证只读；阶段下标由 `noticeStageIndex()` 推导：无采前会=1 / 有采前会=2；
  发布前必填 采购编号+采购时间+采购内容，发布后回填 `publishedAt`）

## 采购工作流子模块（3.x）标准实现套路（照此可复用）
新增一个阶段子模块需要改**六处**：
1. `server/prisma/schema.prisma` 加模型 + `Project`/`ProcurementTask` 两侧反引用 → `gen-sqlite-schema.js` → `db push` → `generate`
2. `server/prisma/migrations/<ts>_add_xxx/migration.sql`（PostgreSQL DDL，仅生产用）
3. `procurement-task.service.ts`：`xxx(taskId)` 读取（返回 editable/published/statusLabel）、
   `saveXxx(taskId, body)`、`serializeXxx()`；`publish()` 里加阶段必填校验 + `publishedAt` 回填
4. `procurement-task.controller.ts`：`@Get(':id/xxx')` + `@Put(':id/xxx')`（权限 `contract:view` / `contract:edit`）
5. `web/src/api/modules.ts` 的 `procurementTaskApi` 加调用；`constants/procurementVariables.ts` 补模块变量
   （**富文本变量要用 `h()` 标记 html，否则会被转义**；**表格变量 key 含连字符，对象字面量里必须加引号**）
6. `web/src/utils/<模块>.ts`（文档 HTML 构建 + 变量取值）与 `web/src/pages/Procurement/<页>.tsx`（路由已存在）

验证三件套：`tsc --noEmit`（server+web）、端到端脚本断言、vite 模块依赖图逐项 200。

## 工具使用坑（重要）
- **同一文件在一条消息里发两次 Edit，其中一次可能不落盘**（已两次踩到：Project 反引用、publish 里 noticeIndex 声明）。
  改同一文件务必**一条消息只发一个 Edit**，改完用 grep 复核。


## 本机依赖安装规程（重要，照此执行可一次成功）
1. pnpm 未全局安装，入口固定在：
   `C:\Users\qingr\.workbuddy\binaries\node\workspace\node_modules\pnpm\pnpm.exe`（v12.3.4，原生二进制）
2. 安装命令必须带三个参数：
   ```
   <pnpm.exe> install --node-linker=hoisted --registry=https://registry.npmmirror.com
   ```
   - `--node-linker=hoisted`：默认 isolated 布局会间歇性 `Failed to create symlink ... 拒绝访问 (os error 5)`
   - `--registry=`：官方源大包必然超时
   - 另设 `PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma`
3. **大二进制下载在本环境会被截断**（curl 实测 200 但 0 字节），antd / echarts 等 10MB 级包下不来。
   web 端若再遇此问题，直接复用旧 npm 版 `node_modules`（历史上 `web/_nm_old_web` → 改名回 `web/node_modules` 即可）。
4. **vite 启动前先删 `web/node_modules/.vite`**，否则会卡在 `Re-optimizing dependencies` 十几分钟。
5. 本机删除大量文件极慢（7.5 万文件 40 分钟未完成）。**应急用 `Rename-Item` 改名（瞬时）腾路径**。
   建议把项目目录 + pnpm store 加入杀软白名单。

## 本地开发数据源（易踩坑）
- `server/.env` 是 `DATABASE_URL="file:./dev.db"`（SQLite），但 `prisma/schema.prisma` 的 provider 是 **postgresql**。
- 本地**不能**跑 `prisma migrate deploy`。正确顺序：
  ```
  node_modules/.bin/prisma generate --schema prisma/schema.sqlite.prisma
  node_modules/.bin/prisma db push  --schema prisma/schema.sqlite.prisma
  ```
- ⚠️ **致命坑（2026-09-13 实测）**：`package.json` 的默认 `prisma:generate` / `prisma db push` **不带 `--schema`**，会落到 `schema.prisma`（postgresql）。
  若最后一次 generate 用的是 `schema.prisma`，生成的 client 会按 postgresql 校验 `DATABASE_URL`，
  **运行时任何 `prisma.xxx.findUnique()` 都会抛 `Error validating datasource db: the URL must start with postgresql://`**。
  无论何时，必须让 **`schema.sqlite.prisma` 的 generate 最后执行**（覆盖 `node_modules/.prisma/client`），
  否则重启后端即报上述错。修复步骤：停后端 → `prisma generate --schema prisma/schema.sqlite.prisma` → 重启。
- 本机启动方式：后端 `server/node_modules/.bin/nest start`（:3000/api）；前端 `web/node_modules/.bin/vite`（:5173，/api 代理到 3000）。
  不要跑 `prisma/seed.ts`，会覆盖 `dev.db` 里的现有数据。

## 已知未纳入版本控制的本地文件
- `server/src/common/utils/chinese-amount.ts`（未跟踪，属本地待提交内容，勿删）

## 采购模块（批次二）阶段链与实现套路
- 单项采购阶段链（后端 `procurement-task.service.ts` 的 `stageChain` 与前端 `procurementWorkflow.ts`
  的 `buildStageChain` **必须同步修改**）：
  `总清单 → [采前会≥100万] → 采购公告 → 采购文件 → 成交报告 → 资审报告 → 价格对比表`
  —— 为让每个模块的「入口条件 = 上一模块已完成」，采购文件、成交报告被依次提到资审报告之前。
- 子模块统一实现套路（3.1~3.5 一致）：Prisma 模型（`taskId @unique` + `publishedAt` + `version`）
  → `migrations/<时间戳>_xxx/migration.sql`（PostgreSQL；SQLite 靠 gen-sqlite-schema + db push）
  → service 的 `xxxStageIndex()/xxx()/saveXxx()/serializeXxx()`，并在 `publish()` 里加必填校验与
  publishedAt 回填 → controller `GET/PUT /:id/xxx`（导入类另加 `POST /:id/xxx/import` 与 `template`）
  → 前端 `utils/procurementXxx.ts`（表格/文档 HTML/变量取值）→ 页面替换 `Placeholder` 占位页
  → `api/modules.ts` + `procurementVariables.ts`。
- 「编辑中 → 已完成」由 stage 推导（`published = task.stage > stageIndex`），不单独存状态字段。
- 纯派生数据不落库：采购清单（3.3/3.4）、四张成交表（3.5）、预计采购金额，均从总清单/明细实时派生。
- Excel 导入：`ExcelService.parse(buffer, [2])`（第 1 行表头、第 2 行模板示例行需跳过），
  模板用 `ImportTemplateService.buildTemplate()`；前端复用 `components/ImportButton.tsx`。

## 项目信息字段（Project 模型）
- 位置类字段：`provinceCity`（项目所在省市）/ `siteLocation`（工程地点）/ `projectAddress`（项目地址），
  均为可空文本；编辑入口在项目管理页「项目信息」表单，列表与导入模板（`project.service.ts` 的
  `template()`/`importProjects()`）已同步三列。
- 三者同时是采购模块**公共变量** `{{项目所在省市}}` / `{{工程地点}}` / `{{项目地址}}` 的数据来源。
  链路：项目管理 → `projectApi.detail` → 采购页面 `project` state → utils 的 ctx → 变量取值表。
- **新增一个公共变量需同步改 5 处**：`constants/procurementVariables.ts` 的 `PROCUREMENT_COMMON_VARS`，
  以及 `utils/procurementDocument.ts` / `procurementNotice.ts` / `preMeetingMinutes.ts` /
  `frameworkExplanation.ts` 四个文件的 ctx 类型与变量取值表，最后让 4 个采购页面把字段塞进 ctx。

## 菜单体系（重要约定）
- 前端菜单**以后端 `GET /api/menu` 为权威来源**，`web/src/components/Sider/menuConfig.ts`
  只在接口失败时兜底。**新增菜单必须同时改 `server/src/modules/system/menu.service.ts` 的 `MENU_TREE`**，
  只改前端 `menuConfig.ts` 不会生效。
- 前端菜单有 sessionStorage 缓存（键见 `Sider/utils/storage.ts`，5 分钟 TTL）。菜单结构调整后
  需递增缓存键版本号（当前 `_v2`），否则旧缓存会继续生效。
- 菜单项 `icon` 字段是字符串，需在 `Sider/utils/iconHelper.tsx` 的 `ICON_MAP` 注册，
  否则兜底为 `FileOutlined`（菜单仍显示，但图标不对）。

## 采购模块
- 采购管理分组（`/procurement/*`，8 个子项：采购发起/采前会会议纪要/采购公告/采购文件/成交报告/
  采购价格对比表/框架协议事前说明/考察报告），子项均未设 permission → 全部登录用户可见。
- 采购模板在「基础信息管理 → 采购模板」（`/base/procurement-template`，permission: template:view）。
- 变量占位符**无独立菜单**，是 `RichTextEditor` 的「插入变量」能力，入口在采购模板/合同模板/合同条款页面；
  配置在 `web/src/constants/procurementVariables.ts`（8 模块 + 公共变量）。
- **单项采购阶段链**（后端 `procurement-task.service.ts` 的 `stageChain()` 与前端
  `constants/procurementWorkflow.ts` 的 `buildStageChain()` **必须同步修改**）：
  `总采购清单 → [采前会会议纪要(≥100万)] → 采购公告 → 采购文件 → 资审报告 → 成交报告 → 采购价格对比表 → 生成合同`
  （任务 3.4 起采购文件调整到资审报告之前，使「采购文件」入口条件 = 采购公告已完成）。
- 子模块状态均**由 stage 推导**（`deriveStatus`），入库仅存 stage/status；
  子模块详情接口统一返回 `reached / editable / published / statusLabel`，
  前端下拉按对应状态过滤（如采购文件仅显示 `DOCUMENT_EDITING` 的任务）。
- 各子模块的清单类数据**不落库**，从 `ProcurementTotalItem` 派生（只读、与总清单一致）。

## 后端运行方式
- 开发环境后端跑编译产物 `node dist/src/main`（非 watch）。**改 `server/src` 后必须
  `nest build` 再重启进程**，否则改动不生效。

## 任务完成验收规程（铁律：每条需求/任务收尾必做）
- **每次任务完成后，必须对本次修改内容做一遍验收（acceptance check），不能只改完代码就交付。**
  原因：改代码极易引入「能编译却跑不起来 / 运行才报错」的系统级错误。本会话已连续踩到两例：
  ①生成的 Prisma client 与运行时 `DATABASE_URL` 协议不匹配（postgres vs sqlite）；
  ②schema 加了字段却没 `db push`，DB 缺列导致 `findMany` 报列不存在。
- 验收清单（按改动类型取舍，能跑则必跑）：
  1. 类型/编译：`web` 跑 `tsc --noEmit -p web/tsconfig.json`；`server` 跑 `nest build`。
  2. 运行时冒烟：改了后端，**重启后端后真打一个会触发改动代码的请求**（如独立脚本复跑报错的那句
     `findMany`/`findUnique`），确认不再报之前的错。仅看启动日志 `successfully started` 不够——
     那只证明进程起来了，不证明查询能跑。
  3. 数据库结构：凡改过 `schema.*.prisma` 加/改字段，务必
     `prisma db push --schema prisma/schema.sqlite.prisma`（不只是 `generate`），
     并用 `PRAGMA table_info(<表>)` 复查列已落地。
  4. 前端改动：必要时 `vite build` 确认打包通过。
- 验收发现的问题当场修，修完再重复验收，直到通过才视为任务真正完成。
