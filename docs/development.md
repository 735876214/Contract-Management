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

**AI 助手（可选）**：`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 三项齐全才启用（OpenAI Chat
Completions 兼容协议）。**更推荐在「系统管理 → AI 信息登记」页面填这三项**——存进 `SysParam`、
保存即生效（不改 env、不重启），优先级高于环境变量（逐项回落：页面 > env > 默认），只配 env 的老部署
行为不变。缺任一项 `/api/ai/status` 返回 `enabled: false`，前端只保留「手工映射」通路
（AI 是加速器不是唯一通路，不做静默降级报错）。其余可调项（**仍只认 env**）：`AI_TIMEOUT_MS`(30000) ·
`AI_MAX_FILE_BYTES`(5242880 = 5MB；multer 层另有 50MB 硬上限) · `AI_MAX_CANDIDATES`(300) ·
`AI_MAX_FIELDS`(120，一次送进 prompt 的字段数) ·
`AI_HOURLY_LIMIT`(60，每用户每小时调用上限，超限 429) · `AI_MAX_TOKENS`(4000，单次返回上限) ·
`AI_MAX_TEXT_CHARS`(40000，登记时送进 prompt 的正文长度上限) · `AI_PDF_FONT`(汇报材料导出 PDF
时内嵌的中文字体**绝对路径**，缺省按 macOS / Debian 常见路径自动探测；`.ttc` 会先拆成单字体再用。
**只认 TrueType 轮廓**：CFF 类的 Noto CJK / 思源嵌进去是乱码，程序会跳过——Linux 上装
`fonts-wqy-zenhei` 或 `fonts-arphic-uming` 即可，镜像里已经装好)。生产按惯例把需要的变量直接写进 `docker-compose.yml` 的 server `environment`。

文件登记（二期）的取数与写入口径见 `docs/03-API接口清单.md` §25：`.docx`/`.xlsx` 才能解析
（`.doc`、PDF 需先另存），`parse` 不写库、`confirm` 才落库；明细默认只做核对参考，
勾选「登记时把明细写入合同物资明细」后才落库（按「名称+规格」匹配物资基础库，匹配不到自动新建并打标记）。

生产部署配置的**敏感项与路径走 `.env`**（2026-10-22 起，模板见仓库根 `.env.example`）：
`POSTGRES_PASSWORD` · `JWT_SECRET` · `DEFAULT_ADMIN_PASSWORD` · `PGDATA_DIR` / `DATA_DIR`（NAS 绝对路径）·
`CMS_PORT`。`docker-compose.yml` 里只写 `${VAR:?}` 引用，口令缺失会直接启动失败；
NAS 上实际生效的那份在 `deploy/nas/`（与该目录的 `.env` 一起被 gitignore）。
前端仅用 `VITE_API_BASE`（部署时由镜像设 `/api`）与 `VITE_PROXY_TARGET`（dev 代理）。

## 3. 命令速查

| 位置 | 命令 | 作用 |
|---|---|---|
| server | `npm run build` | `nest build` |
| server | `npm run start:dev` | 开发热重载 |
| server | `npm run start:prod` | `node dist/src/main` |
| server | `npm run seed` | 写入演示数据（字典/角色/项目/合同/…） |
| server | `npm run test` | node:test **纯函数单测**（74 个 spec，无 DB，**CI 门禁**） |
| server | `npm run test:int` | **DB 集成测试**（12 个 spec，需 `DATABASE_URL` 指向测试库，**CI 门禁**） |
| server | `npm run test:anomaly` | 6-9 预警的 5 个用例文件快速回归（规则/阈值/措辞/取数形状/评分，无 DB） |
| server | `npm run anomaly:export -- --project <id>` | **只读**导出 6-9 评测数据集（8 张表 → JSON，含规则初判候选，供人工标注） |
| server | `npm run anomaly:score -- --dataset <json> --truth <json>` | 用真值文件算召回/误报并出门槛（不达标退非 0），可 `--out` 写 Markdown 报告 |
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
  | `test/contractChain.spec.mts` | **合同当前金额口径锁**（= 主合同 + Σ 补充协议 `changeAmount`，**不采信手填 amount**）· 主合同未填 → 当前金额未知（`null`，不是"只算补充协议"）· 只算直接补充协议、防环 · 链上累计结算（排除草稿/自身）与累计付款（排除失败/退款） |
  | `test/contractFulfillment.spec.mts` | **合同履约派生进度（零表，2026-10-18）**：已收/已结/已付/开票比例 · 分母未知或为 0 → `null`（显式 0 照常参与）· 超收/超结/超付用负数暴露 · 「有收货未结算」「有结算未付款」标记 |
  | `test/contractArchive.spec.mts` | **合同归档完整性检查**（业务口径 2026-10-18，单向归档）：未签章 / 草稿结算 / 未完成总结算 / 未挂结算收领单 / 未纳入结算日报行 / 有下游但未「已完已结」→ 阻断 · 无下游的已签章合同可归档 · 待查验发票 / 未付款只提示不阻断 |
  | `test/assetFlow.spec.mts` | **物资进出场方向与汇总**（业务口径 2026-10-18：只做物资、零新表）：采购/调入 = 进场，调出/处置 = 出场，调入费/维保费只计金额 · 未知来源单列、不混入进出场 · 数量/金额按方向汇总 |
  | `test/materialCategories.spec.mts` | **物资一/二级分类表锁**（业务 2026-10-18）：一级 10 项、二级 67 项、编码唯一 · 二级父级必须存在且 (父级, 名称) 不重复 · 每个一级至少一个二级 · 旧编码/旧名称映射目标都存在 |
  | `test/supplementDelta.spec.mts` | **补充协议带符号增量算法**：涨价/降价只计**差额**（防止把"剩余数量的全值"重复计入）· 增数量按原单价 · 新增物资全额 · 未知类型一律 0 · 主合同查不到的物资按全额并计数 |
  | `test/supplierSnapshot.spec.mts` | **签订时快照口径**（业务口径：合同正文导出取签订时快照）：`KEEP`（默认）快照优先逐字段回退实时 · `SYNC` 强制实时 · 快照缺失（存量合同）行为不变 · 空串视为未提供 · **扫源码核对快照字段清单覆盖 `generate()` 用的全部 `sup.*`**（漏一项就会静默回退实时） |
  | `test/payRatio.spec.mts` | **付款安排与「当前生效比例」**（业务口径 2026-10-16）：两种月度安排的分期与比例（`M65_1` 次月 30 日 65%；`M65_3` 次月/次次月/次次次月 20/20/25，浮点求和须回到 0.65）· 存量 `100`/`3382` **不得改** · 生效比例四条规则（已完已结 = 100% 压过月度安排 · 按安排 · 自定义取手填 · **推不出 → `null` 不覆盖**，手填 0 也算推不出）· **前后端镜像**（`web/src/constants/paymentModes.ts` 的取值集合与 label 逐条相等——下拉里显示的就是它） |
  | `test/amountAlert.spec.mts` | **金额红/黄预警阈值**：红 = 结算 > 当前金额×110% 或 补充协议 > 主合同×130%；黄 = 80% / 110%；**恰好等于阈值不预警** · 红优先 · 分母未知时不误报 · 同文件还锁 **付款超比例预警**（开累付款 > 开累结算 × 生效比例；比例未填/为 0 **不报**、分母为 0 不报、"恰好等于上限"不算超） |
  | `test/ledgerDerived.spec.mts` | **台账派生金额口径**（**未填金额 ≠ 0**）：合同额 NULL 时「100% 欠款」「已结算占合同比例」返回 `null` 而不是 0/负数 · 显式填 0 是真实的 0 · 分母为 0 → 比例不可计算 · 常规数值与修复前逐位一致 |
  | `test/mask.spec.mts` | 敏感字段打码白名单（凭据/银行账号/证件号/联系方式；不修改入参） |
  | `test/importTask.spec.mts` | 导入任务僵尸判定（心跳阈值/终态不回收）与幂等去重键 |
  | `test/overdueSummary.spec.mts` | 逾期利息**汇总口径单一实现**（开累/上期开累/本期结算；含「手工期初填在较早月份」回归） |
  | `test/templateRender.spec.mts` | 合同模板占位符只认 `{{变量名}}`（**废弃写法不再被替换**的回归锁；值不转义、未取到值原样保留） |
  | `test/listColumns.spec.mts` | 列表列显隐偏好（localStorage 键与降级、至少保留一列、受保护列、列过滤） |
  | `test/tabsStore.spec.mts` | **多页签导航纯逻辑**（`web/src/utils/tabs.ts`）：编辑器标签键与列表键**必须不同**（两者是独立页面实例）· `tabKeyOf` 只认 `editor` 参数并把噪声参数归一（否则会开出重复标签）· 重复打开**不得重置 version**（重置会让页面反复重挂载、页面状态缓存静默失效）· 关闭当前标签的落点顺序（右邻 → 左邻 → 首页）· 超出上限时**只淘汰非编辑器标签**（编辑到一半的页面被淘汰 = 无声的数据丢失）· 持久化**跳过编辑器标签**且能容忍各种脏数据 |
  | `test/clauseSelection.spec.mts` | **条款选择规则锁**（业务口径 2026-10-16：条款只在「合同条款」维护，采购发起第三步/合同起草只做选择）：四个槽位 ↔ 四种条款类型**一一对应**，且与前端条款库页的类型下拉（`web/src/constants/clauseTypes.ts`）逐条一致 · 快照规则：`techQuality` = 技术条款正文 +（选了质量条款时）质量条款正文（换行拼接），`acceptanceMethod`/`paymentMethod` 各取自己的条款正文 · 槽位显式传 `null` = 清除 → 快照**一并清空**（否则界面看着没选、模板变量却还有值）· 全清空归 `null` 不归空串（保持"未填"语义）· 条款不存在 / 类型放错槽位 → 走调用方的 400 |
  | `test/dashboardTodo.spec.mts` | **「我的待办」分类的前后端镜像锁**（业务口径 2026-10-16：为每个模块都预留一个待办位置，0 条的分类 Tab 也常驻）：`server/src/constants/todoCategories.ts` ↔ `web/src/constants/dashboardTodoTabs.ts` 的 key/label **逐条一致且顺序相同** · 每分类必须声明权限码（决定对哪些用户可见）· 下发上限合理 · key 不重复 |
  | `test/archiveNaming.spec.mts` | **项目资料归档命名规则锁**（附件需求 2026-10-17）：目录清单 = 业务确认的 13 类（key/dir 不重复；**无** 4.收领单台账、**无** 12.采购文件）· 项目根 = `nameAbbr` 回退 `name`、非法字符清洗 · 收领单/发票 = `供应商-物资-结算账期-单据名.pdf`（**图片统一转单页 PDF**，扩展名固定 .pdf）· 账期目录 `2026.1 → 2026年1月` · 重名追加 (2)(3) 保留扩展名 · 空目录占位 `_说明.txt` 文案 |
  | `test/storageKeys.spec.mts` | 存储键纯逻辑（相对键规范化 / 越权路径 `..`·绝对路径拦截 / 绝对路径与对外 URL） |
  | `test/storageUrl.spec.mts` | **文件引用归一化**：相对键 / `/api/files/...` / 完整 URL / 双前缀 → 相对键；绝对路径与 `..` 保留以交给安全校验 |
  | `test/storageAudit.spec.mts` | **本地文件审计（只读）**：missing / orphans / duplicates / invalid 分类与计数；空引用跳过；文件键归一 |
  | `test/uploadRules.spec.mts` | **上传类型规则**：拦截 html/svg/js/exe 等可执行/可脚本类型；pdf/office/图片/压缩包/dwg 等业务格式放行 |
  | `test/importTemplateCascade.spec.ts` | **导入模板级联下拉**（2026-10-18）：命名区域名合法化（非法字符→`_`、中文保留）· `INDIRECT` 区域名 = 前缀_父级 · 同名子选项跨父级各自成组不去重 · 真实 xlsx 序列化读回逐项断言 |
  | `test/milestone.spec.mts` | **履约节点逾期派生**（四域扩展按需项 2026-10-18）：到期日当天不逾期、过期未完成=逾期 · DONE/SKIPPED 不逾期 · 无/非法 planDate 不逾期 |
  | `test/templatePlaceholderSyntax.spec.mts` | **种子模板占位符语法漂移锁**（`prisma/seed.ts` 与模板文件不得出现单花括号；内容能被渲染器吃干净） |
  | `test/statusCodes.spec.mts` | **核心状态 code 漂移锁**（常量 ↔ 字典项 ↔ `schema.prisma` 的 enum；五态合同类型 / 任务状态 / 各状态组） |
  | `test/noDbPush.spec.mts` | **迁移纪律**：可执行配置（package.json/CI/compose/Dockerfile/scripts）里禁止 `prisma db push`（剥注释避免误报） |
  | `test/storageBoundary.spec.mts` | **文件 I/O 边界**：`server/src` 里除 `StorageService` 外不得出现 `fs.` 调用 |
  | `test/docStats.spec.mts` | **活文档统计数字漂移锁**：本文件与 `CLAUDE.md` 里的 spec/model/模块/迁移计数须与代码一致，且本表列全了每个 spec |
  | `test/themeTokens.spec.mts` | **色值来源锁**：`web/src` 里除白名单（`theme.ts`、`index.css`、`Sider/index.less`、`RichTextEditor.tsx`、`docExport.ts`）外不得出现 `#hex` / `rgb()` 字面量——视觉改动只改 token 层 |
  | `test/startupSeed.spec.mts` | **启动播种的并发安全锁**：`src/main.ts` 与 `test-integration/helpers.ts` 都必须走 `runStartupSeed()`（不得直接调 `seed*` 函数）· 该入口必须保留**事务级**咨询锁（会话级在连接池下会「加锁/解锁不同连接」）。起因：CI 空库上多进程并发播种撞 P2002 → 字典漏播、用例红，而**本地因库已播种完全看不见** |
  | `test/aiFormScan.spec.mts` | **AI 填表槽位识别**（`server/src/modules/ai/form-scan.ts`，零依赖）：列字母/引用换算（1→A、27→AA、703→AAA，非法列号返回空串）· 标签归一（中英文冒号、全角空格）· 表头连排（`序号|名称|数量`）**不产出槽位** · 冒号结尾标签的右邻按值处理（已填的短中文公司名不会被当成另一个标签）· 纵向「标签在上值在下」· 同一格不被两个标签占用 · 截断保留前 N 个并**报告丢弃数量**（不静默截断） |
  | `test/aiReport.spec.mts` | **汇报材料的事实包与产出对账**：`factsToMarkdown` 数字/风险/折算齐全 · `auditReport` **编造的数字必须被抓出来**、千分位与万元写法可识别、**量词（份/条/家）与百分比都参与对账**（2026-10-20 审计：原来一律跳过，等于编造的份数与百分比永远查不出来；百分数容许取整 82.38%→82%）、日期与章节序号不参与对账、**有序列表序号（`1.`/`2)`）不算数**（接真上游时实测误报过 2、3）、未知数字去重且有上限 · `markdownToHtml` 标题/列表/粗体/表格/HTML 转义/闭合 · 三种材料标签齐备 |
  | `test/aiRegisterMaterials.spec.mts` | **合同物资明细的落库映射**：`numOf` 吃千分位/货币符号/百分号且取不到返回 null（不落 0、不落 NaN）· 兼容 `unitPriceWithTax`/`amountWithTax` 与中文列名 · 合价缺失用「数量 × 单价」补齐并计数 · 缺名称与同「名称+规格」重复行被丢弃并计数 · 单位缺失兜底「项」· 税率未知时税前单价留空 · 非数组输入不抛错 · `itemsTotalWithTax` 四位小数累加 |
  | `test/aiReportPdf.spec.mts` | **汇报材料 PDF 排版**（pdf-lib，无文件 I/O）：标题居中与层级字号 · 列表圆点行 · 表格分隔行丢弃、单元格用 `·` 连 · 粗体标记抹掉 · `wrapText` 按宽度折行不丢字、空串给一行、超长串可切 · `renderReportPdf` 多页分页且产出合法 PDF（magic 为 `%PDF-`）、标题写进元数据 · 空正文出单页 |
  | `test/aiTtcFont.spec.mts` | **TTC 字体集 → 单字体 TTF 提取**（汇报材料 PDF 内嵌中文字体用，零依赖纯函数）：认 `ttcf` 魔数、读字体数量 · 按表记录把选中的那一支重排偏移复制成独立 sfnt（表数据字节级一致、`align4` 对齐）· 非 TTC / 序号越界 / 表数据越界一律抛错（不静默截断） |
  | `test/aiRegister.spec.mts` | **AI 文件登记的纯函数层**：金额去千分位/货币符号 · 日期接受 `2026-08-01`/`2026/8/1`/`2026年8月1日`/`2026年8月`（日缺省 1 号）· 税率吃 13 / 13% / 0.13 · `isRealDay` 拒绝「格式对但不存在」的日期（2026-02-30 / 2025-02-29 / 2026-04-31，避免被 `new Date` 静默归一成下个月）· **每个值回原文核对**（`textHasMoney`/`textHasDate` 真命中用例 + 不命中用例）· 合同类型「执行合同」优先于「采购合同」· 付款安排从条款推断、判不出返回 null · `normalizeExtraction` 规整字段并给 `cross-check`/`missing-required`/`invalid`/`unverified` 告警 · 金额三角与明细合计对账 · 非法枚举不落库 · docx XML → 带表格结构的文本（单元格 ` \| ` 分隔、实体解码、空文档不抛错）· `looksLikeContract` 不误判短文 |
  | `test/aiPrompt.spec.mts` | **AI prompt 安全底线 + 模型输出规整**：**prompt 里绝不出现字段值**（`currentValue` 被显式忽略，用例直接断言值串不在消息里）· 字段/候选清单文本与截断 · `normalizeMapping` 丢弃越界序号/非整数/未知键 · 同一候选留最高置信度、同一字段只留一个（防两格填同一值）· confidence 夹 0~1 且 3 位小数 · 垃圾输入不抛错 · 字段目录键唯一、未关联合同时不下发 contract/supplier 域字段 |
  | `test/aiSetting.spec.mts` | **AI 配置取值优先级（页面登记 > 环境变量 > 默认值）**：页面填了逐项覆盖 env（不是整体替换）· 页面只填一部分 → 其余回落 env（老部署只配 env 的行为不变）· 空串/空白视为未登记 · 页面开关关掉即不启用且仍回显地址 · 页面开关打开压过 `AI_ENABLED=false` · **开关开着但缺 API Key 仍不启用**（避免「界面说已启用、调用必 401」）· 存储键名锁定 `ai.*` 命名空间（改名会让存量配置静默失效） |
  | `test/aiAnomalyPayment.spec.mts` | **AI 预警「结算/付款异常」的 8 条规则**（矩阵课题 6-9；纯函数，`server/src/modules/ai/anomaly/`）：金额全程 `bigint` 分（`Decimal(18,2)` 超 2^53 不丢精度 · 分位半进位 · **未填 ≠ 0** · 付款比例只认 0~1 小数，`13` 这种「百分数误填」必须 null 而不是 13 倍）· 夹具**双向对锁**（脏数据 8 条规则各命中、共 10 条；净数据 0 命中——防误报比防漏报更要紧）· `DRAFT` 结算与 `FAILED/REFUNDED` 付款不计入累计 · 付款**恰好等于**比例上限不算超付、超容差才报 · 跨单累计超清单量才判（没有清单量口径 → 记 `notEvaluated`）· 缺口径必须显式说出来（**0 命中 ≠ 账没问题**）· 输出确定性（两次调用逐字相同、HIGH 全排在 MEDIUM 之前） |
  | `test/aiAnomalyPrompt.spec.mts` | **AI 预警的阈值解析 + 措辞兜底**（同一模块，`anomaly-config.ts` / `anomaly-prompt.ts`）：系统参数 `ai.anomaly.*` 全空取默认值 · `0/false/off` 认作关 · **非法值回落并留 problem**（不静默变成「永不报」）· 金额容差按元→分、`0` 合法（严格相等）、负数与非数回落 · 数量容差夹 0~100、Jaccard 夹 0~1 · 默认值表必须覆盖全部键 · **数字对账**：模型结论里出现 `facts` 之外的数字即判编造（`HT-2026-001` 这类单据编号里的数字**不**误判）· 允许 0~10 计数词 · 兜底文案把「0 命中」与「N 条规则未判定」分得开（**0 命中 ≠ 账没问题**）· 提示词含铁律「不得计算任何新的数字」「不得给法律/税务定性」 |
  | `test/aiAnomalyBench.spec.mts` | **6-9 评测夹具与评分器**（`anomaly-bench.ts`）：同 seed 逐字节可复现 · 换 seed 只动随机量（超付额） · `mulberry32` 分布不退化 · 规模与注入条数（12 合同 / 61 结算单 / 9 条注入） · **8 个规则码全覆盖** · 规则层召回 100% 且**零误报** · 干净合同 c09～c12 零命中 · `notEvaluated` 为空 · **评分器自校准**（删真值→该命中变误报；加真值→变漏报） · 分列召回口径 · 判定结果可渲染 Markdown · 重复评测结果稳定 · 规模护栏（2 001 单 < 2 s） |
  | `test/aiAnomalyDataset.spec.mts` | **6-9 取数形状层**（`anomaly-dataset.ts`）：线上接口与离线评测共用同一份 `select`/`where`/行映射（各写一份等于「评测对象 ≠ 线上代码」）· 清单量按**链根**聚合、同物料求和、游离合同丢弃；聚合键必须是链根而非签约主体（否则补充协议永远「超额结算」）· `currentPayRatio` 从 `ext` 取、缺失为 null（R2 记未判定而不是超付）· **每个 where 都显式带 projectId**（跨项目串数据是事故）· 结算日期只约束结算单 · 窄列护栏（不得顺手 SELECT *）· 假 Prisma 行 → R3 命中端到端 |
  | `test/aiAnomalyScore.spec.mts` | **6-9 真值对账评分层**（`anomaly-score.ts`）：评分单位是 `(code, entityId)` 唯一键（不是「条数」）· 真值解析**带下标爆炸**（缺字段 / `hit` 非布尔 / 重复标注都要报——标注写错被静默忽略就会伪装成规则漏报）· 误报区分「人工判定不该报」与「真值未标注」· **按规则拆分召回**（合计 90% 掩盖某条规则 40% 是最危险的读法）· 真值无 `hit=true` 时召回为 `null` 而非 0%（不许给出假结论）· 门槛（召回比例 + 误报条数）与 Markdown 报告四段（空清单写「无。」） |
  | `test/aiQuoteBidder.spec.mts` | **AI 预警「报价与价差」的 12 条规则与真值夹具**（矩阵课题 3-9；纯函数，`server/src/modules/ai/quote/`）：报价一律取 `ProcurementBidder` **结构化行**（JSON 快照只是发布快照）· 成交价口径 `最终确认价 → 第二轮 → 第一轮` 回退 · 控制价合计 = Σ 数量 × `planPrice`，缺项跳过（**未填 ≠ 0**）· 两轮降幅 ±、首轮离散系数（**只用首轮**，第二轮受议价影响天然收敛）、成交价与控制价双向偏离、单行成交单价超控制价/偏离市场价、税率合法性（0/1/3/5/6/9/11/13% ± 0.30pp）与两轮税率漂移、非最低价中标、家数不足与中标缺报价 · 夹具**12 条注入异常逐条对上 `(任务号, code, entityId)`**，另带一条干净任务做**零命中**负向断言 · 阈值可覆盖且非法值回落 · 坏数据不中断扫描（其余任务真值一条不少） · 每条事实自带「元/%/家」（模型只许照抄，不许自己算） |
  | `test/aiQuotePrompt.spec.mts` | **AI 预警「报价与价差」的阈值解析 + 措辞兜底**（同一模块，`quote-config.ts` / `quote-prompt.ts`）：`ai.quote.*` 九个参数**缺省用默认值且不报问题**、脏数据（「开吧」「一块钱」「很多」）**回落默认并留一句人话**、越界值夹到边界（降幅 300% → 100%、家数 99 → 20）、**负金额容差回落**、阈值文案把七个阈值都写成人话（面板与提示词共用同一句）· 对账：照抄 `facts` 与 `taskNo`（`PROC-20261001-001` 不被误判成编数字）通过、**模型自己算的金额（3000000.00）被挑出**、0~10 计数词放行而 12 要能对上 facts · 模板兜底：0 命中写明「未命中」、有命中按等级与类型汇总并给优先处理项、**未判定规则必须写进结论** · 提示词：范围/样本/阈值/命中清单/未判定清单齐全、12 条命中**不截断**、system 里写着不许算数/不许法律定性/不许声称核对原始单据 |
  | `test/aiLlmRetry.spec.ts` | **推理型模型「只输出思考、没有正文」的重试口径**（接真上游时发现：`only_reasoning` 模型把 `max_tokens` 先花在 `reasoning_content` 上，思考一长就 `finish_reason:"length"` + 空 `content`，表现为同样提示词随机失败）：空正文且预算烧在思考上 → `max_tokens` 翻倍重试**一次**（未设 maxTokens 时兜底 ≥4096）· 两次都空 → `EMPTY` 错误且消息点明「推理模型、思考占满预算」（不是密钥/地址错）· 首次就有正文不重试 · 真·空回复（无思考、`finish=stop`）不重试，直接报「上游返回空内容」 |
  | `test/aiQuota.spec.ts` | **AI 配额（每用户每小时）的计数与失败退还**（2026-10-20 审计 P2：原来调用前扣、失败也计，上游一挂就把额度烧光并锁一小时）：逐次计数 · 达上限抛 429 · `limit<=0` 不限次 · 不同用户各自计数 · `refund` 退还一次后可再调 · 重复退还/从未调用不会退成负数 · 窗口滑过后旧计数失效 |
  | `test/loginThrottle.spec.ts` | **登录失败节流（撞库防护）**（2026-10-20 第 2 轮审计：原来 `login` 只记失败日志、不限制次数，`admin/admin123` 这种默认口令可被跑穿）：键 = `用户名|IP`（用户名去空格转小写，避免大小写各占一个窗口）· 15 分钟内失败 5 次后 `assertNotThrottled` 抛 **429** 且文案带「N 分钟后再试」· 成功一次即清零 · 窗口过期自动放开（不用重启）· 不同账号/不同 IP 互不影响（共用出口 IP 的同事不被连坐）· 单键只保留最近 `maxFailures` 条（长跑不膨胀） |
  | `test/projectScope.spec.ts` | **项目口径收口（跨项目 IDOR）**（2026-10-20 第 3 轮审计：`@ProjectId()` 只回答「能不能进这个项目」，不回答「URL 里这条数据的 id 属不属于它」，于是 `findUnique({ where: { id } })` 成了跨项目读/改/删的入口）：有请求上下文就补 `projectId` · 无上下文（seed/定时任务/单测）保持原样 · 调用方在 `extra` 里塞别的 `projectId` 不能放宽过滤 · 查不到抛 404 且文案不暴露「存在但不属于你」 |
| `test/money.spec.ts` | **金额/税率的舍入口径**（2026-10-20 第 4 轮审计：`toFixed` 家族是**四舍六入五成双**，`1.005 → 1.00`、`8.85 → 8.8`；`num()` 不拒绝 `Infinity`、`-0`）：`round2/round4` 按「四舍五入」且带 EPSILON 修正 · 大额与负数对称 · `toMoney` 空值/非法值给 null 而不是 0 · 税额、含税/不含税互算在 1e-4 精度内闭合 |
| `test/commonGuards.spec.ts` | **导入解析 / 附件地址 / 结算状态三个守卫**（2026-10-20 第 8、9 轮审计）：`parseImportDate` 认 `2026年1月31日`、`2026/1/31`、Excel 序列号（45000 → 2023-03-15），识破 `2026-02-30`，空值给 null 而不是 1970 · `pickDictCode` 非空未命中返回 null 由调用方报行级错误（不能静默写 NULL） · `isSafeFileUrl` 只放行站内 `/...` 与 http(s)，`javascript:`/`data:`/`//host` 一律拒 · `assertSettlementProgress` 只允许沿链路前进，回退必须走驳回 |
| `test/csvExport.spec.ts` | **导出防护与字段长度兜底**（2026-10-21 第 16、19 轮审计）：`csvCell` 给以 `= + - @` 开头的值补单引号（Excel 打开 CSV 会把 `=cmd|'/c calc'!A1` 当公式执行），负数与小数保留为数字、按 RFC 4180 包裹引号换行 · `pickFields` 超 10 万 字符的字符串抛 400（Prisma 的 String 是 text，无 DTO 时能塞进几 MB） |
  | `test/settlementPeriod.spec.mts` | **月度结算期纯函数**（业务口径 2026-10-16）：期 = 起始日 → 下月同日的前一日 · 自动生成结算抓的是**上一期**（业务原例：起始日 1 日、10/2 运行 → 抓 9/1–9/30）· 起始日 26 时**期跨自然月**（标签取期末所在月）· 起始日 29/30/31 在小月取月末 · `periodKeyOf` 判「同一结算期」（发票/收领单归属结算单就用它；起始日 1 日时与自然月等价）· `periodMonthKey` 容错解析「结算账期」自由文本 |
  | `test/settlementFromDaily.spec.mts` | **总日报 → 结算明细带出**（业务口径 2026-10-18：有总日报才有结算单、明细从日报带出且可改）：同物资多行按数量**加权平均**单价 · 金额按与 `normalizeItem()` **同一公式**重算（表头金额 = Σ 明细合价）· 缺 `materialBaseId` 的行计入 `skippedRows` 并带出名称（不静默丢）· 无单价 → 合价 `null`、金额按 0；显式 0 仍是 0 |
  | `test/laborReceiving.spec.mts` | **劳务队领用月度汇总派生口径**（附件需求 2026-10-17 第二批）：净领 = 领用 − 退库（领用未填 → null）· 扣款单价 = 单价 × 1.2 · 设计小计 = 开累 × (1+损耗率) · **节超 = 实耗 − 设计小计**（正 = 超耗，样表口径）· 扣款只在超耗时发生（节约 → 0、口径未知 → null）· 实际损耗率分母 0/未知 → null · **三态契约**（未填 ≠ 0，显式 0 照常算）· 平均单价 = Σ税前总价 ÷ Σ数量 |
  | `test/docVariables.spec.mts` | **单据模板变量（第三套体系）**：面板与取值表**逐条一致** · 金额类变量名必须带单位后缀 `(元)` · 面板给 `raw` 一律是 `{{key}}` · 取值表对缺失对象返回空串（不写 `undefined`）· **源码扫描**：`RichTextEditor.insertVariable` 默认插入的是**双花括号**（2026-10-16 修过：默认值曾是 `{key}`，插了不替换） |
  | `test/excelParse.spec.ts` | **Excel 解析口径与表头行探测**（2026-10-20 审计）：`detectHeaderRow` 在「导出文件（logo 占 1~2 行、表头第 3 行）」与「填写模板（表头第 1 行、必填列带 `*`）」两种布局下都定位正确、列名对不上回退第 1 行 · `parse(buf, [], headerRowNo)` 按指定行取表头且不把表头行当数据 · **导出 → 探测 → 解析闭环**（这正是字典「导出后原样导回」静默 0 行的回归点） |
  | `test/docExcel.spec.mts` | **单据 Excel 渲染引擎**（`doc-excel.ts`）：单值/混排占位符替换（未取到值原样保留）· **表格占位符整格独占时真正的行展开**（向右向下写二维数组、插行、复制占位符行的样式与行高）· **下方合并单元格区域随插行下移**（ExcelJS 的 `spliceRows` 本身不会移动合并区域，不重映射就会「数据下移、合并框留原处」）· 空表清掉占位符且保留样式 · 占位符与文字混排时退回多行文本兜底 |
  | `test/docTemplateFile.spec.mts` | **单据模板文件键与文件名纯逻辑**：`normalizeDocTemplateFileKey` 剥 `/api/files/`（含双前缀）与完整 URL、保留其它绝对路径交给安全校验 · `.xlsx` 大小写通过、`.xlsm/.docx/.xls` 拒绝（宏会丢）· **前端 `toStorageKey/toFileUrl` 与后端逐条一致** |
  | `test/mtsConstraints.spec.mts` | **`.mts` 加载约束锁**：被 `.mts` spec 引用的模块内部，相对 `import` 必须带扩展名（别人给零依赖叶子加一行 `from './x'` 即红，报错直接给出两种修法） |
  | `test/containerQuery.spec.mts` | **组件级响应式（Container Queries）漂移锁**：视口值只许页面外壳用 · `@container` 条件只能写等于 `CONTAINER_BREAKPOINTS` 的字面值（`var()` 不被解析）· `container-type` 只许挂 `.cq`/`.ant-modal-body`/`.ant-drawer-body` · `containerSize.ts` ↔ `--cq-*` ↔ 规则三处一致 · `containers.css` 必须在 `index.css` 之后引入 · `.doc-preview` 必须挂 `.cq` · `.col-secondary` 规则成对 · 窄容器表单栅格覆盖不得含 `.cq` · `RichTextEditor` 必须 portal 全屏层且内容同步 effect 依赖 `fullscreen` |

  > 断言项数（`node:test` 输出的 `pass` 数）**不写进文档**：它随每次加/改用例变动，以命令输出为准。
  > 但**加了 spec 文件就必须在本表登记**——`test/docStats.spec.mts` 会校验本表列全了每个 spec。

- **前端无独立测试框架**（不引入 jest/vitest）：前端纯逻辑通过 `server/test/*.spec.mts`
  直接 import `web/src/**` 中的**无 `@/` 别名依赖**模块来覆盖（见 `frontendChainParity.spec.mts` 的注释）。
  要求：① `.mts` 由 Node 原生擦除类型加载，故 **Node 需 ≥22.18**（本地 v24、CI 用 24）；
  ② 被测文件若有**相对**运行时 `import`，**必须带扩展名**（`from './x.ts'`；`import type` 可被擦除，
  裸包与内置模块可以）。前端质量门另有 `npm run build` 中的 `tsc --noEmit`。

  > **`.mts` 的约束**（2026-10-15 专项调查；**2026-10-17 解除第 ① 条**，`server/test/mtsConstraints.spec.mts` 继续锁）：
  > ① 相对 import 必须带扩展名——**已解除「零依赖叶子」限制**：tsconfig 开了
  > `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（配 `ts-node.experimentalResolver`），
  > src 模块可写 `from './x.ts'`：nest build / ts-node 在 emit 时自动改写为 `.js`（产物无 `.ts` 残留），
  > `.mts` 原生 loader 也直接认识 `.ts` 后缀。**无扩展名相对 import 仍禁止**（`from './x'` 会运行时炸）。
  > 已接线范例：`procurementFlow.ts` import `./statuses.ts`；两份单据变量共享 `doc-var-shared.ts`。
  > ② **装饰器与 JSX 不被擦除**：NestJS 服务（`@Injectable()`）
  > 与 `.tsx` 组件**永远**进不了 `.mts`——这是结构性限制，**不是编译选项问题**，想覆盖它们只能用
  > `test-integration/`（ts-node），引入打包器型测试框架已被本仓库否决；③ 内联 enum / 带运行时的
  > namespace 同样不支持。
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
| `settlement-link.int.spec.ts` | 结算台账 ↔ 结算单关联：结算单保存后**自动生成台账行并挂 `settlementId`**（改造前 `syncLedgerByContract` 全仓无调用点）· **同合同同月第二张结算单被 400 拦住** · 改月份时**先清后挂**（`settlementId` 唯一键，否则新月建行撞旧月）· 删结算单后台账行退回「仅费用行」· **只有资金费用没有结算单时也建行** · 台账「保理贴息/逾期利息」写入一律 400 |
| `settlement-period-link.int.spec.ts` | 发票/收领单 ↔ 结算单关联 + **月度结算生成**（业务口径 2026-10-18：明细从**总日报**带出）：发票保存自动挂**同结算期**的结算单（只有账期落在本期、开票日期在别的月份也按账期归）· 台账「本月开票额」按**关联**归集、改账期后自动解绑并回落 · 人工把发票挂到**别的结算期** → 400 · 收领单保存自动匹配、显式传 `null` 解绑 · 生成结算单（按物资合同分组、明细从总日报按物资聚合、`settleDate` = **期末**、期内收领单仅回挂、**重跑幂等**且迟到的收领单只补关联不改金额）· **手工日报行（无收领单）也参与生成** · `require_confirmed` 开启时未确认日报行不计入 · 起始日 26 时 **9/28 的日报行与期末 10/25 的结算单同期**（用自然月判会漏） |
| `contract-fulfillment.int.spec.ts` | **合同履约派生进度（零表）**（业务口径 2026-10-18）：合同链金额（主合同 + 补充协议增量）· 已收量按总日报且只算「已确认」· 结算排除草稿 · 付款排除失败/退款 · 发票合计 · 跨项目 404 |
| `contract-archive.int.spec.ts` | **合同归档锁定**（业务口径 2026-10-18，单向）：未签章/草稿结算阻断 · 下游收口后可归档 · 归档后合同/结算/收领单写入口 400、读取仍可用 · 不可重复归档 |
| `contract-milestone.int.spec.ts` | **合同履约节点**（四域扩展按需项 2026-10-18）：CRUD 全链与 overdue 派生 · 跨项目 404 · 非法状态 400 · 归档合同禁止写 · 逾期节点进工作台 OVERDUE_MILESTONE 组 |
| `material-categories.int.spec.ts` | **物资分类字典与基础库引用**（2026-10-18 分类表）：启动同步后一级 10/二级 67 项且二级挂一级 · 创建物资存名称、同名二级按一级归位 · 二级不属于所选一级/旧分类名 → 400 · 只传二级自动带出一级 · 导入模板的一/二级分类列**预置下拉**（隐藏选项表 + 数据验证） |
| `amount-guard.int.spec.ts` | 金额上限闸门：`BLOCK` 真的拦住超结/超付、`WARN` 放行、草稿豁免、**合同未填金额=无上限**、失败/退款不计入累计、**补充协议带符号增量进上限**（降价→上限下降拦住原本合法的单；增项→回升放行；求和用 `changeAmount` 而非手填 `amount`） |
| `contract-flow.int.spec.ts` | 合同 草稿→审批中→签章→驳回 全链 + 采购任务状态联动 + 签章件落盘/下载 + 两条防误改规则（非主合同、阶段链未走完） |
| `import-two-phase.int.spec.ts` | 导入两阶段：一行非法 → **零写入**、全合法 → 写入并计数、同一文件并发提交 → 复用同一任务 |
| `tender-bidders.int.spec.ts` | 招标域：导入**双写**结构化投标单位与幂等、有评标记录的单位不被静默删除、勾选候选人=**定标**（WON+确认价）与取消回落、评标记录全量替换与三条校验、**定标行 → 发布 → 生成多份合同**（快照被篡改也不采信） |
| `settlement-item.int.spec.ts` | **清单项级结算明细 + 量级校验**（业务 2026-10-17）：items 随结算单落库、综合单价/合价由服务端重算 · update 整体替换明细（replace-all）· 量级闸门（Σ明细量 + 历史已结 ≤ 合同链清单量）：**WARN 策略带 overQtyWarning、BLOCK 策略 400** · 链上无清单行的物资=**无上限不拦** · **草稿不校验量级**（提交时才拦） |
| `template-management.int.spec.ts` | **三套模板管理语义**（2026-10-18）：合同模板新建接受 Y/N 归一、编辑生成新版本且**停用真的生效**、过期 version 409、**删除整条版本链** · 采购模板 `keyword/moduleType/status` 筛选与 `{list,total}` 分页形态、非法状态 400、同类型覆盖写版本快照、停用后不出现在 `status=1` 查询 · 单据模板**历史 `/api/files/` URL 入库归一为相对键**并能读盘渲染、`.docx`/损坏/不存在文件一律 400 |

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

### 5.2.1 响应式改动的**容器级**验收（不能只切视口）

组件级响应式（Container Queries，规则见 [DESIGN.md](../DESIGN.md) §10.2）的判定依据是**容器宽度**，
所以"切三档视口看页面"**测不到它**——1280 视口下把表格塞进 900px 弹窗，视口量出来仍是"宽屏"。

正确手法：**固定视口，只改容器宽度**，看同一视口下形态是否翻转（这才是 CQ 与视口断点的判别点）：

```js
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, ... });  // 全程不动
// 断言初始形态 → 再只改容器：
await evaluate(`document.querySelector('.ant-modal-body').style.width = '600px'`);
await sleep(600);                                    // 等 ResizeObserver + React 重渲染
// 断言：列数 / max-width / flex-basis / padding / 表头集合 变了，且视口仍是 1280
```

已用此手法验证过的判别点（照抄即可）：弹窗内 `md={12}` 的 `max-width` 100% ↔ 50% ·
`.col-secondary` 列的显隐 · 列表页筛选区 `flex-basis` 25% ↔ 50% · 台账冻结列数 2 ↔ 1 ·
`.doc-preview` padding 24 ↔ 12 · 卡片 KPI 字号。

⚠️ 两个坑：① 断言 `getComputedStyle` 的值（`max-width`/`flex-basis`/`display`）比数元素个数稳，
antd 会留占位行与隐藏浮层；② 打字要用 `Input.dispatchKeyEvent{type:'char'}`，
`Input.insertText` 在 headless 下不一定触发 React 的 `onInput`（受控组件的值不会更新，测出来是假结果）。

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
- [ ] **⑨ 响应式改动**：按 §5.2.1 做**容器级**验收（固定视口、只改容器宽度，断言形态翻转）——
      只切视口证明不了 Container Queries 生效；顺带跑三档视口回归确认没破版。

## 7. 编码约定

- **统一响应** `{ code, data, message, timestamp }`；异常走 `AllExceptionsFilter`，别在 controller 手写返回体。
- **权限**：controller 类级 `@UseGuards(JwtAuthGuard, PermissionsGuard)` + 方法级 `@RequirePermissions('x:view')`。
- **项目隔离**：controller 用 `@ProjectId()` 取，service 显式带入 `where`（见 [architecture.md §5](architecture.md)）。
- **写字段白名单**：service 用 `pickFields` 过滤未知字段。
- **乐观锁**：更新时 `assertVersion(oldRow, data)`（不一致抛 409）。
- **字典**：下拉/标签/颜色走字典；业务表存字典项**编码字符串**，不新增数据库枚举。
- **采购阶段子模块**需同步改六处（schema+反引用 → 迁移 SQL → service → controller → 前端 api/变量 → utils/页面），
  硬约定见 [../CLAUDE.md](../CLAUDE.md) §4（改动前必看的高危约定），变量体系（三套）与约定见
  [../.claude/rules/procurement-and-tender.md](../.claude/rules/procurement-and-tender.md)「三套变量体系」。
- 前端样式遵循 [../DESIGN.md](../DESIGN.md)；组件接口见 [component-api.md](component-api.md)。

## 8. 构建与部署

```bash
# 本地构建单容器镜像（仓库根执行）
docker build -f deploy/single/Dockerfile.single -t cms-single:local .

# 生产（拉最新镜像）：先编辑 docker-compose.yml——两条 NAS 数据路径 + JWT_SECRET（不用 .env）
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
- **改代码用编辑器/Edit 工具，别用 `sed`/`python -c`/`node -e`/heredoc 拼字符串**：heredoc 会吞反斜杠
  （`\b` 曾写成退格符 0x08，导致正则静默失效、断言恒真）；确要用脚本改，改完必须 `cat -A` 或重跑测试复核。
  ⚠️ **含中文（尤其全角标点 `（）「」`）的批量替换只能用 Edit 工具**——经 shell 传参时这些字符会被改写：
  2026-10-16 实测 `node -e` 收到的字符串里全角括号变了样，`split/join` 因此**命中错位**，
  把一批文件里所有 `（` 替换成了别的字（连"压缩多余空格"的正则也把行首 2 空格缩进一起压掉，
  12 个文件被整体改写）。恢复正常的方式是 `git show HEAD:<路径> > <路径>`（比 `git checkout --` 更不容易被权限拦），
  然后用 Edit 重做。
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
- **本机 `server/.env` 可有可无**（已 gitignore）：只用 dev 容器时不建也能跑；要**宿主机直跑后端**
  （`PORT=3100 node dist/src/main.js`）才需要，且连接串指向 compose 映射出来的 `15432`
  （主库 `cms`、集成测试库 `cms_int`、影子库 `cms_shadow`）。直跑两个坑：① 宿主机 3000 被 dev 容器占着，
  换 `PORT=3100`；② `JwtModule` 已改 `registerAsync + ConfigService`——装饰器顶层读 `process.env` 时
  `.env` 还没加载，会造成「登录成功但所有接口 1401」。
- **AI 助手联调**：模型网关若只有 IPv6（如 `workbuddy.735876214.xyz`），宿主机能连、**Docker 容器没有
  IPv6 出口**（`ENETUNREACH`），所以 AI 联调要宿主机直跑后端，再把前端容器反代指过去：
  `VITE_PROXY_TARGET=http://host.docker.internal:3100 docker compose -f docker-compose.dev.yml up -d web`
  （dev compose 已把该变量做成可覆盖，默认仍是 `http://server:3000`）。这类网关的 API Key
  **大小写敏感**，遇到 401 `invalid_api_key` 先核对原样大小写。
- **改后端要重启 dev 容器**：`docker compose -f docker-compose.dev.yml restart server`
  （`nest start --watch` 不感知宿主机新增/修改的文件，见 §6 ③）。
- **容器里的 `<defunct>` 僵尸进程（2026-10 已根治，别把 `init: true` 删了）**：dev compose 的
  postgres / server / web 三个服务都开了 `init: true`，由 tini 当 PID1 负责回收孤儿进程。
  - **症状**：调试久了容器里 `<defunct>` 越来越多；`kill -9` 它们毫无反应（Z 状态不占 CPU/内存，
    只占 PID 表槽位，要等父进程 `wait()` 才消失），只有重建容器才清得掉——「删不掉」不是权限问题，
    是僵尸进程的定义。
  - **自检**：`sh scripts/dev-zombie-check.sh`（逐个容器扫 `/proc/*/stat` 数 Z，退出码 1 = 有僵尸；
    容器基础镜像通常没有 `ps`，脚本因此不用 `ps`）。
  - **清理**：`sh scripts/dev-zombie-check.sh --fix`，或
    `docker compose -f docker-compose.dev.yml up -d --force-recreate`（数据在命名卷里，不会丢）。
  - **为什么需要 init**：没有它 PID1 就是应用自身（`npm` / `npx` / `nest`，都是 node 进程），
    node 只回收自己 fork 的孩子，不回收「过继」来的孤儿；调试期间的短命进程
    （watch 热重启的旧实例、prisma schema-engine、IDE attach 残留、`docker exec` 里的临时命令）
    生父先退出后就被挂到 PID1 名下，退出即定格成 Z。生产 compose 与 NAS compose 早就用 `init: true`
    兜住了，只有 dev compose 漏了——这就是「只有调试时才出问题」的由来。
  - 同理：给 dev 服务加 healthcheck / 探针时也要确认 `init: true` 还在，否则探针命令会成为僵尸来源。
- **改前端要真渲染核验**：手法见 §5.2（Edge headless + CDP）。两条实践细节：
  ① 先访问 `/login` 再注入 `cms_token` 再跳目标路由（直接冷启动到受保护路由会被 `RequireAuth` 弹回登录页）；
  ② 断言"控制台无报错"时要先**过滤 `chrome-extension://` 噪音**（headless 的 Edge 里挂了扩展，
  会持续抛 `siteHostMap` 异常，否则全站每一步都"失败"）。

