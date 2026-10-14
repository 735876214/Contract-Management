# 开发指南（Development）

> 面向开发者：环境搭建、命令、数据库迁移规则、测试、部署与**回归清单**。
> AI 助手请先读 [../CLAUDE.md](../CLAUDE.md)。

## 1. 环境要求

- Node 20（CI/镜像用 `node:20-slim`；本地开发容器用 `node:20`，含 openssl，Prisma 需要）
- **npm**（锁文件 `server/package-lock.json`、`web/package-lock.json` **已入库**）。
  安装命令统一带 `--legacy-peer-deps`，与镜像/CI 的 `npm ci --legacy-peer-deps` 完全一致
  （2026-10 从 pnpm 收敛到 npm，原因见 README「依赖管理」）。
- **改了依赖后**：在对应目录执行 `npm install --package-lock-only --legacy-peer-deps` 刷新锁文件并一起提交；
  否则镜像/CI 的 `npm ci` 会因 `package.json` 与锁文件不一致而失败。
- Docker + Docker Compose（开发与部署）
- PostgreSQL 16（由 compose 提供，本地默认映射 `15432`）

## 2. 本地启动

### 方式 A · 容器化一键调试（推荐）

```bash
docker compose -f docker-compose.dev.yml up
# 前端 http://localhost:5173（Vite HMR）
# 后端 http://localhost:3000/api
# PostgreSQL 映射到本机 15432；上传文件落 ./data-dev
# 首次启动自动装依赖（数分钟）；无需宿主机装 node/npm
```

容器内的 `server` 命令链会自动执行 `prisma generate` → `migrate deploy` → `start:dev`；
`web` 用 `VITE_PROXY_TARGET=http://server:3000` 代理 API，并开文件轮询（`CHOKIDAR_USEPOLLING`）。
调试端口 `9229` 已暴露：把 `start:dev` 改成 `start:debug` 后 IDE 可 Attach。

### 方式 B · 宿主机直跑

```bash
# 只起数据库
docker compose -f docker-compose.dev.yml up -d postgres     # → 本机 15432

# 后端
cd server
cp .env.example .env            # 确认 DATABASE_URL 端口为 15432
npm ci --legacy-peer-deps
npm run prisma:deploy              # 空库一次建全表（折叠基线 20260901000000_init）
npm run seed                   # 可选：字典/角色/演示数据
npm run start:dev                  # http://localhost:3000/api

# 前端
cd ../web
npm ci --legacy-peer-deps
npm run dev                        # http://localhost:5173（/api 反代 localhost:3000）
```

### 环境变量

`server/.env`（参考 `server/.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 本地 postgres | 连接串；dev 用 15432 |
| `JWT_SECRET` | `cms-super-secret-key` | 生产必改（`openssl rand -base64 48`） |
| `JWT_EXPIRES_IN` | `7d` | Token 有效期 |
| `PORT` | `3000` | 后端端口 |
| `UPLOAD_DIR` | `./uploads` | 上传目录（静态映射 `/api/files`） |
| `DEFAULT_ADMIN_USERNAME/PASSWORD` | `admin`/`admin123` | 空库启动自动建管理员 |

根 `.env`（生产 compose，参考 `.env.example`）：`CMS_HTTP_PORT`(9080) · `CMS_DATA`(./data) ·
`JWT_SECRET`(必填) · `DEFAULT_ADMIN_USERNAME/PASSWORD`。
前端仅用 `VITE_API_BASE`（部署时由镜像设 `/api`）与 `VITE_PROXY_TARGET`（dev 代理）。

## 3. 命令速查

| 位置 | 命令 | 作用 |
|---|---|---|
| server | `npm run build` | `nest build` |
| server | `npm run start:dev` | 开发热重载 |
| server | `npm run start:prod` | `node dist/src/main` |
| server | `npm run seed` | 写入演示数据（字典/角色/项目/合同/…） |
| server | `npm run test` | node:test **纯函数单测**（24 个 spec，无 DB，**CI 门禁**） |
| server | `npm run test:int` | **DB 集成测试**（4 个 spec，需 `DATABASE_URL` 指向测试库，**CI 门禁**） |
| server | `npm run prisma:generate` | 生成 Prisma Client |
| server | `npm run prisma:migrate` | `prisma migrate dev`（生成新迁移） |
| server | `npm run prisma:deploy` | `prisma migrate deploy`（应用迁移） |
| web | `npm run dev` | Vite 开发服务器 |
| web | `npm run build` | **`tsc --noEmit && vite build`** |
| web | `npm run preview` | 预览构建产物 |
| 根 | `docker compose up -d --build` | 本地构建单容器镜像并启动 |
| 根 | `docker build -f deploy/single/Dockerfile.single -t cms-single:local .` | 只构建镜像 |

## 4. 数据库与迁移规则

- **唯一数据库：PostgreSQL**。模型全在 `server/prisma/schema.prisma`（单一 schema）。
- 改了 schema 后：

  ```bash
  cd server
  npx prisma migrate dev --name <描述>   # 生成并应用迁移
  ```

- **禁止 `prisma db push`**：它不会生成迁移文件，会让数据库脱离迁移历史，问题只在别人或生产上暴露。
- `server/prisma/migrations/20260901000000_init` 是「空库 → 当前 schema」的**折叠基线**：
  空库首次 `migrate deploy` 一次建全表；之后按时间戳叠加新迁移。
- ⚠️ **从 2026-09-17 之前的旧库升级**：需先 `migrate resolve --applied 20260901000000_init`
  标记基线（只写迁移记录，不动数据），再拉新版本。步骤见 [../README.md](../README.md)。
- 种子数据三个来源：
  - `server/prisma/seed.ts`（CLI，`npm run seed`）：完整演示数据；
  - `server/src/seed.ts`（后端启动自动、幂等）：`seedAdmin` / `seedDefaultProject` / `seedDictAndParams`
    / `fixLegacyData`（增补字典与系统参数、修正历史数据——**新增字典/参数加在这里**，勿改自动生成的 `seed-data.ts`）；
  - `server/src/seed-data.ts`（自动生成的字典/参数初始数据，**勿手改**），上两者共用。

## 5. 测试

- 后端（`cd server && npm run test`，使用 **Node 内置 `node:test`**，非 jest/vitest）：

  | 文件 | 覆盖 |
  |---|---|
  | `test/procurementFlow.spec.ts` | 采购工作流单一事实源（类型/合同类型推导/阶段链/门禁/多合同生成/列表分支） |
  | `test/workflowGuards.spec.ts` | 三处驳回状态机（合同签章/结算/成交报告）+ 现场确认（日报行）状态机 |
  | `test/frontendChainParity.spec.mts` | **前后端阶段链一致性锁**（跨包 import 前端常量；含「合同状态→任务状态」映射） |
  | `test/schemaDanglingRefs.spec.mts` | **schema 悬空引用漂移锁**（解析 `schema.prisma`，白名单豁免有意弱关联） |
  | `test/procurementVariables.spec.mts` | 采购变量「面板定义 ↔ 取值表」一致性锁 |
  | `test/procurementVariableRender.spec.mts` | 变量取值行为（金额单位/别名解析/占位符保留与转义） |
  | `test/routePermissionParity.spec.mts` | **路由权限守卫 ↔ 后端菜单一致性锁** |
  | `test/ledgerColumns.spec.mts` | 合同台账列宽单位契约（Excel 字符宽 → 像素，防「表头竖排」复发） |
  | `test/amountGuard.spec.mts` | 防超结/防超付的金额上限判定 + 合同链口径（排除草稿、排除失败/退款、无金额→无上限） |
  | `test/overdueCalculator.spec.ts` | 逾期利息引擎（DAYS360 / 付款分配 / 开累；手算对照） |
  | `test/ledgerCompliance.spec.mts` | 合同台账合规判定（执行类 vs 非执行类的节点比较与优先级） |
  | `test/mask.spec.mts` | 敏感字段打码白名单（凭据/银行账号/证件号/联系方式；不修改入参） |
  | `test/importTask.spec.mts` | 导入任务僵尸判定（心跳阈值/终态不回收）与幂等去重键 |
  | `test/overdueSummary.spec.mts` | 逾期利息**汇总口径单一实现**（开累/上期开累/本期结算；含「手工期初填在较早月份」回归） |
  | `test/templateRender.spec.mts` | 合同模板占位符只认 `{{变量名}}`（**废弃写法不再被替换**的回归锁；值不转义、未取到值原样保留） |
  | `test/listColumns.spec.mts` | 列表列显隐偏好（localStorage 键与降级、至少保留一列、受保护列、列过滤） |
  | `test/storageKeys.spec.mts` | 存储键纯逻辑（相对键规范化 / 越权路径 `..`·绝对路径拦截 / 绝对路径与对外 URL） |
  | `test/templatePlaceholderSyntax.spec.mts` | **种子模板占位符语法漂移锁**（`prisma/seed.ts` 与模板文件不得出现单花括号；内容能被渲染器吃干净） |
  | `test/statusCodes.spec.mts` | **核心状态 code 漂移锁**（常量 ↔ 字典项 ↔ `schema.prisma` 的 enum；五态合同类型 / 任务状态 / 各状态组） |
  | `test/noDbPush.spec.mts` | **迁移纪律**：可执行配置（package.json/CI/compose/Dockerfile/scripts）里禁止 `prisma db push`（剥注释避免误报） |
  | `test/storageBoundary.spec.mts` | **文件 I/O 边界**：`server/src` 里除 `StorageService` 外不得出现 `fs.` 调用 |
  | `test/docStats.spec.mts` | **活文档统计数字漂移锁**：本文件与 `CLAUDE.md` 里的 spec/model/模块/迁移计数须与代码一致，且本表列全了每个 spec |
  | `test/themeTokens.spec.mts` | **色值来源锁**：`web/src` 里除白名单（`theme.ts`、`index.css`、`Sider/index.less`、`RichTextEditor.tsx`、`docExport.ts`）外不得出现 `#hex` / `rgb()` 字面量——视觉改动只改 token 层 |
  | `test/mtsConstraints.spec.mts` | **`.mts` 加载约束锁**：被 `.mts` spec 引用的模块内部，相对 `import` 必须带扩展名（别人给零依赖叶子加一行 `from './x'` 即红，报错直接给出两种修法） |

  > 断言项数（`node:test` 输出的 `pass` 数）**不写进文档**：它随每次加/改用例变动，以命令输出为准。
  > 但**加了 spec 文件就必须在本表登记**——`test/docStats.spec.mts` 会校验本表列全了每个 spec。

- **前端无独立测试框架**（不引入 jest/vitest）：前端纯逻辑通过 `server/test/*.spec.mts`
  直接 import `web/src/**` 中的**无 `@/` 别名依赖**模块来覆盖（见 `frontendChainParity.spec.mts` 的注释）。
  要求：① `.mts` 由 Node 原生擦除类型加载，故 **Node 需 ≥22.18**（本地 v24、CI 用 24）；
  ② 被测文件不得有**相对**运行时 `import`（`import type` 可，会被擦除；裸包与内置模块可以）。
  前端质量门另有 `npm run build` 中的 `tsc --noEmit`。

  > **`.mts` 的三条硬约束**（2026-10-15 专项调查结论，`server/test/mtsConstraints.spec.mts` 锁第 ① 条）：
  > ① **相对 import 必须带扩展名**（Node ESM 不做推断）——**本仓构建侧未开扩展名选项，故对
  > `server/src` 模块而言实际等于"不得新增相对 import"**（要么抽成零依赖叶子，要么先开下面两个选项）。
  > 这条会随别人改动突然出现（给零依赖叶子加一行 `from './x'`），故由测试锁住，且**覆盖多行 import 形态**；
  > ② **装饰器与 JSX 不被擦除**：NestJS 服务（`@Injectable()`）
  > 与 `.tsx` 组件**永远**进不了 `.mts`——这是结构性限制，**不是编译选项问题**，想覆盖它们只能用
  > `test-integration/`（ts-node），引入打包器型测试框架已被本仓库否决；③ 内联 enum / 带运行时的
  > namespace 同样不支持。
  > 真要解除 ①（让被测模块复用兄弟模块）：`tsconfig` 开 `allowImportingTsExtensions` +
  > `rewriteRelativeImportExtensions`（TS ≥5.7；本仓锁文件的 typescript 已是 5.9.3，**不是版本障碍**），
  > 并把相关相对 import 补成 `./x.ts`；注意 ts-node（`.ts` spec / seed / `test:int`）需同步验证，
  > 且收益**仅限纯逻辑模块**；放宽范围到全仓 371 处相对 import 不值得。
- 联调/验收脚本（**非单测**，需要先起本地栈，会写数据）：

  ```bash
  node scripts/e2e-procurement-flow.mjs      # 采购工作流端到端（走前端代理 5173/api）
  node scripts/verify-async-import.js        # 异步导入（>1000 行）验收；环境变量 BASE/ROWS
  node scripts/verify-import-rollback.js     # 导入事务回滚验收；环境变量 ROWS/BAD_ROW
  ```

  这些脚本**不在 CI 里跑**（CI 只跑无 DB 的单测 + DB 集成套件）；改动采购工作流时人工跑一遍。
  断言项数随用例增减（脚本末行自己会打印 `N/M 通过`），故不在此写死。
  注：早期文档里提到的 `e2e-module-list.py` 早已不存在（2026-10-14 清理时确认），采购六模块列表
  由 `e2e-procurement-flow.mjs` 覆盖。

## 5.1 DB 集成测试（`npm run test:int`）

纯函数套件（`npm test`）**不碰数据库**——它证明不了"闸门到底接上没有"。真事务、真约束、真闸门由
`server/test-integration/*.int.spec.ts` 覆盖（用 `NestFactory.createApplicationContext(AppModule)`
拿真实 DI 后直接调 service，**不引入 `@nestjs/testing`**）：

| spec | 覆盖 |
|---|---|
| `amount-guard.int.spec.ts` | 金额上限闸门：`BLOCK` 真的拦住超结/超付、`WARN` 放行、草稿豁免、**合同未填金额=无上限**、失败/退款不计入累计 |
| `contract-flow.int.spec.ts` | 合同 草稿→审批中→签章→驳回 全链 + 采购任务状态联动 + 签章件落盘/下载 + 两条防误改规则（非主合同、阶段链未走完） |
| `import-two-phase.int.spec.ts` | 导入两阶段：一行非法 → **零写入**、全合法 → 写入并计数、同一文件并发提交 → 复用同一任务 |
| `tender-bidders.int.spec.ts` | 招标域：导入**双写**结构化投标单位与幂等、有评标记录的单位不被静默删除、勾选候选人=**定标**（WON+确认价）与取消回落、评标记录全量替换与三条校验、**定标行 → 发布 → 生成多份合同**（快照被篡改也不采信） |

```bash
# 1) 准备一个**专用测试库**（库名必须含 test 或 int，否则测试拒绝启动——防误连开发/生产库）
docker exec cms-postgres-dev psql -U cms -d postgres -c 'CREATE DATABASE cms_int;'
# 2) 跑（脚本内已含 prisma migrate deploy）
cd server && DATABASE_URL="postgresql://cms:cms123456@localhost:15432/cms_int?schema=public" npm run test:int
```

- 每个用例自建独立 `Project`（业务表都带 `projectId`）隔离，**不清理数据**；测试库可随时重建。
- ⚠️ 报 **P3005（database schema is not empty）** = 该库的迁移历史被清掉了（典型原因：把
  `prisma migrate diff --shadow-database-url` 指到了它）→ `DROP DATABASE` + `CREATE DATABASE` 重建即可。
- ⚠️ `migrate diff` 的**影子库必须是另一个库**（如 `cms_shadow`）——它会重置影子库内容；
  CI 里用 `prisma db execute --stdin` 先建影子库，再跑 diff。

## 5.2 前端真渲染核验（本机无 Playwright）

构建通过**发现不了**「表头被挤成竖排」「弹窗溢出屏幕」这类破版，改前端 UI 必须真渲染看一眼。
本机与 CI 都没有浏览器自动化库（无 Playwright/Puppeteer/Selenium），可行路径是
**Edge headless + CDP 直连**（零依赖：Node 自带 `WebSocket` 与 `fetch`）：

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录> \
  --no-first-run --disable-gpu --hide-scrollbars about:blank
```

然后写一个临时 `mjs` 驱动（放 `%TEMP%`，**不要留在仓库里**）：

1. `fetch http://127.0.0.1:9333/json/list` 取页面目标的 `webSocketDebuggerUrl`；
2. `Page.navigate` 到 `/login`，用 `Runtime.evaluate` 注入
   `localStorage.cms_token` 与 `localStorage.cms_project_id`（token 由 `POST /api/auth/login` 现取），
   再 `Page.navigate` 到目标路由；
3. 用 `Runtime.evaluate` 断言/驱动 DOM（点按钮、读表头、读 `localStorage`）；切视口用
   `Emulation.setDeviceMetricsOverride`（375 / 768 / 1280）；
4. `Page.captureScreenshot` 存图后用 Read 工具**看图**确认版式。

⚠️ 断言要挑**可见**元素（如 `.ant-popover:not(.ant-popover-hidden)`）——antd 会把关闭的浮层留在 DOM 里，
拿 `.ant-popover` 直接量会得到 `width: 0` 的假通过。

## 6. 回归清单（改完必做，做完才算完工）

> 这是本项目的「验收铁律」。逐条执行并确认，不要"改完即报完成"。

- [ ] **① 编译门禁**：`cd web && npm run build`（含 `tsc --noEmit`）与 `cd server && npm run build` 均通过。
- [ ] **② 真打接口**：重启后端，**实际请求一次触发改动的接口**确认不报旧错——只看启动日志不算。
- [ ] **③ schema 变更**：`npx prisma migrate dev --name …` 生成并应用迁移，复查目标列/表已落地。
- [ ] **④ 前端构建**：涉及前端改动时确认 `vite build` 通过（`npm run build` 已含）。
- [ ] **⑤ 采购工作流改动**：同步改后端 `constants/procurementFlow.ts` 与前端 `constants/procurementWorkflow.ts`，
      并跑 `cd server && npm run test` 确认一致性锁通过。
- [ ] **⑥ 菜单改动**：改后端 `menu.service.ts` 的 `MENU_TREE`（权威来源）；
      icon 在 `Sider/utils/iconHelper.tsx` 的 `ICON_MAP` 注册；递增 `Sider/utils/storage.ts` 缓存键版本。
- [ ] **⑦ 导入改动**：确认「全成功或全失败」与 >1000 行异步路径仍成立；跑 `npm run test:int`
      （`import-two-phase.int.spec.ts` 会在真库上验证「零写入」与并发去重）。
- [ ] **⑦' 金额 / 状态流转改动**：跑 `cd server && npm run test:int`——纯函数单测证明不了闸门与状态机
      **是否真的接上了**（金额上限策略、合同↔任务状态联动都在集成套件里）。
- [ ] **⑧ 项目隔离**：新增业务查询/写入确认带上 `projectId`（或明确属于 dict/finance/supplier 例外）。

## 7. 编码约定

- **统一响应** `{ code, data, message, timestamp }`；异常走 `AllExceptionsFilter`，别在 controller 手写返回体。
- **权限**：controller 类级 `@UseGuards(JwtAuthGuard, PermissionsGuard)` + 方法级 `@RequirePermissions('x:view')`。
- **项目隔离**：controller 用 `@ProjectId()` 取，service 显式带入 `where`（见 [architecture.md §5](architecture.md)）。
- **写字段白名单**：service 用 `pickFields` 过滤未知字段。
- **乐观锁**：更新时 `assertVersion(oldRow, data)`（不一致抛 409）。
- **字典**：下拉/标签/颜色走字典；业务表存字典项**编码字符串**，不新增数据库枚举。
- **采购阶段子模块**需同步改六处（schema+反引用 → 迁移 SQL → service → controller → 前端 api/变量 → utils/页面），
  硬约定见 [../CLAUDE.md](../CLAUDE.md) §4（改动前必看的高危约定），变量体系与缺陷清单见 [06](06-变量体系梳理与歧义清单.md)。
- 前端样式遵循 [../DESIGN.md](../DESIGN.md)；组件接口见 [component-api.md](component-api.md)。

## 8. 构建与部署

```bash
# 本地构建单容器镜像（仓库根执行）
docker build -f deploy/single/Dockerfile.single -t cms-single:local .

# 生产（拉最新镜像）
cp .env.example .env        # 必填 JWT_SECRET
docker compose up -d

# NAS 一键部署/更新
bash scripts/nas-deploy.sh
```

- 单容器镜像 `ghcr.io/735876214/cms-single` 由 CI 构建：push `main` / tag `v*` 触发，
  **仅 linux/amd64**，输出 `latest` 与 `sha-<sha>` 两种 tag。
- 镜像内 `nginx.conf` 托管前端并把 `/api` 反代到同容器后端；`start.sh` 用 bash `wait -n`
  实现「任一进程退出即整体退出」由重启策略自愈。
- 详见 [../README.md](../README.md) 与部署文件 [deploy/single/](../deploy/single/)。

## 9. 工具与本机操作要点（AI 助手/自动化脚本必看）

> 这一节是**干活时的操作坑**，不是项目规则（项目规则见 [../CLAUDE.md](../CLAUDE.md)）。
> 每条都是本机（Windows + Git Bash）实测踩过的。

- **判成败看退出码，不要 grep 输出**：`nest build` 的输出带 ANSI 颜色码，`grep "error TS"` 会漏判
  （见 §6 ①）；另外 **`cmd | head` 的 `$?` 是 `head` 的**，要判成败就别接管道——直连命令，
  或 `> "$LOG" 2>&1` 落文件后再 grep。
- **临时文件不要用 `/tmp`**：Git Bash 会把 `/tmp/x` 解析成 `C:\tmp\x`，重定向常报 `Permission denied`。
  一律用 `C:/Users/<用户>/AppData/Local/Temp/...`。
- **Git Bash 会把 `/` 开头的参数当路径改写**：`node shot.mjs /dashboard out.png` 里的 `/dashboard`
  会变成 `C:/Program Files/Git/dashboard`（导航到非法 URL，页面停在登录页，**症状极像"登录态没注入成功"**）。
  传路由/Unix 绝对路径参数时加 `MSYS_NO_PATHCONV=1`，或把值写进脚本而不要走命令行。
- **改代码用编辑器/Edit 工具，别用 `sed`/`python -c`/heredoc 拼字符串**：heredoc 会吞反斜杠
  （`\b` 曾写成退格符 0x08，导致正则静默失效、断言恒真）；确要用脚本改，改完必须 `cat -A` 或重跑测试复核。
- **推送只走 SSH**：`git push git@github.com:735876214/Contract-Management.git main`
  （本机 HTTPS 的 POST 被阻断）。推完 `git status` 可能仍显示 `ahead 1`，需用同址
  `git fetch git@github.com:735876214/Contract-Management.git main:refs/remotes/origin/main` 复核远端。
- **Prisma 命令的非交互姿势**：`prisma migrate dev` 在非交互 shell 直接拒绝。改完 schema 生成迁移用
  ```bash
  npx prisma migrate diff --from-migrations prisma/migrations \
    --to-schema-datamodel prisma/schema.prisma \
    --shadow-database-url "postgresql://cms:***@localhost:15432/cms_shadow?schema=public" \
    --script > prisma/migrations/<时间戳>_<名字>/migration.sql
  ```
  再 `npm run prisma:deploy`。⚠️ **影子库会被这条命令重置**——绝不能指向 `cms_int` 或任何真库
  （迁移历史会被清掉，随后 `migrate deploy` 报 P3005）。
- **本机没有 `server/.env`**：跑 prisma/seed 要内联连接串
  （dev PG 由 compose 映射到 `15432`：主库 `cms`、集成测试库 `cms_int`、影子库 `cms_shadow`）。
- **改后端要重启 dev 容器**：`docker compose -f docker-compose.dev.yml restart server`
  （`nest start --watch` 不感知宿主机新增/修改的文件，见 §6 ③）。
- **改前端要真渲染核验**：手法见 §5.2（Edge headless + CDP）。两条实践细节：
  ① 先访问 `/login` 再注入 `cms_token` 再跳目标路由（直接冷启动到受保护路由会被 `RequireAuth` 弹回登录页）；
  ② 断言"控制台无报错"时要先**过滤 `chrome-extension://` 噪音**（headless 的 Edge 里挂了扩展，
  会持续抛 `siteHostMap` 异常，否则全站每一步都"失败"）。
