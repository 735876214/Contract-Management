# CLAUDE.md · AI 进入本项目的必读信息

> 面向 AI 编码助手的项目入门。**动手前先读完本文件**，其余细节见文末索引。
> 本文件只写**现状**与**会踩的坑**；历史修复记录见 `git log`，不再搬到这里。

## 1. 这是什么

**企业合同管理系统（CMS）**：面向工程/采购型企业的合同全生命周期管理，覆盖
`项目 → 供应商/分包商 → 采购工作流 → 合同 → 日报/收领单 → 结算付款 → 发票 → 台账 → 还款协议` 主链路，
并配套模板、通知、看板与系统管理。
**已定的产品口径**（2026-10-16 业务答复，别再重新提议）：
- **无多级流程引擎**：合同流转就是 `status`（草稿中 → 待签章 → 已签章）+ `/sign` + `/reject` 的状态回退；
  不做可配置流程，CLAUDE.md 与代码里也不再使用"审批"这一说法。
- **付款只有单表台账** `PaymentRecord`（登记**已完成**的付款），**不做**「计划 / 申请 / 核销（三单匹配）」。
- **变更靠补充协议链表达**并**结构化**：**合同当前金额 = 主合同金额 + Σ 补充协议 `changeAmount`（带符号增量）**；
  工作台对超 110%/80%（或补充协议超 130%/110%）出红/黄**预警**（只展示、不拦单据）。
- **合同正文导出取签订时快照**（`Contract.supplierSnapshot`，签章时冻结；参数 `supplier.name.sync.history` 控制
  `KEEP`/`SYNC`）。
- 不引入 Flowable / Redis / MQ / 物化视图 / DB 枚举（理由见 [docs/05](docs/05-四域扩展可行性评估.md) §2/§5 与本文件铁律 4）。

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
│   ├── prisma/migrations/          # 折叠基线 20260901000000_init + 9 个增量迁移
│   │                               #   （p1_consistency / site_confirmation / scrub_log_secrets
│   │                               #    / import_task_recovery / canonicalize_template_placeholders
│   │                               #    / tender_bidder_and_evaluation / contract_change_and_snapshot
│   │                               #    / drop_contract_type_enum / settlement_ledger_link）
│   ├── prisma/seed.ts  src/seed.ts  src/seed-data.ts
│   ├── src/common/     # 通用层：统一响应/异常/装饰器/Excel/导入/日志/系统参数/存储
│   ├── src/constants/  # procurementFlow.ts（采购工作流单一事实源）、statuses.ts、workflowGuards.ts
│   ├── src/modules/    # 22 个业务模块
│   ├── test/           # node:test 纯函数单测（30 个 spec，无 DB；清单见 docs/development.md §5）
│   └── test-integration/ # DB 集成测试（5 个 spec，需 PostgreSQL：npm run test:int）
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
   例外：**签订时快照** `Contract.supplierSnapshot`（`contract.service.sign()` 冻结）——那是"历史合同再导出
   不该被主数据改写"的留痕，不是把供应商信息冗余进合同；模板取值走"快照优先 → 逐字段回退实时"。

## 4. 改动前必看（细则在 `.claude/rules/`，按需加载）

> ⚠️ **`.claude/rules/*.md` 不会自动加载**：命中下表场景时**先读对应文件再动手**。
> 表里只写"最容易忘的那一句"，完整规则（含锁定它的测试、细节所在的文档）在文件里。

| 改动场景 | 先读 | 该文件覆盖的坑 |
|---|---|---|
| 后端 service / 迁移 / 结算 / 台账 / 日志 | [.claude/rules/backend-conventions.md](.claude/rules/backend-conventions.md) | 六处同步 · 外键清洗与 `@relation` · 乐观锁 · 写字段白名单 · 日志脱敏白名单 · 主合同判定（**`list[0]` 不是主合同**）· 日报行是结算量唯一来源 · 金额上限（**无金额 = 无上限**）· 台账列宽是**字符宽不是像素** · 存储单一入口 |
| 招标·投标·评标 / 成交报告 / 采购变量 | [.claude/rules/procurement-and-tender.md](.claude/rules/procurement-and-tender.md) | 导入**双写**（JSON 快照 + 结构化行）· 定标 = 勾选候选人 · 生成合同**只从结构化中标行取价** · 采购总清单带入合同清单 · 变量名必须带单位 · 面板别漏 `variableScope` · 项目字段名两套 |
| 导入 / 模板与占位符 | [.claude/rules/import-and-templates.md](.claude/rules/import-and-templates.md) | 两阶段「全成功或全失败」· 心跳回收 · 幂等去重（**命中后不得再 execute**）· 占位符只认 `{{}}` · **种子模板有两处** |
| 前端页面·组件·样式·路由 | [.claude/rules/frontend-conventions.md](.claude/rules/frontend-conventions.md) | `perm()` 工厂 + 权限码与菜单同码 · 视觉只改 token 层（禁写死色值）· **断点两层：外壳看视口 / 组件看容器（CQ）** · 列显隐两条路别混用 · 菜单权威在后端 |
| 测试 / 改金额·状态·导入 | [.claude/rules/testing.md](.claude/rules/testing.md) | 两套测试分工（改金额/状态/导入**必跑 `test:int`**）· `.mts` 三条硬约束（装饰器与 JSX **永远**进不了）· 新增 spec 要同步 §5 清单与计数 |

**最高频的 5 条**（直接写在这里，省得每次都翻文件）：

1. 改模型必须出迁移（**禁 `db push`**）；加外键先在同一迁移内清洗数据。
2. 项目隔离：新增查询/写入**自己带 `projectId`**（例外见 §3 铁律 3）。
3. 状态 code 写常量（`SETTLEMENT_STATUS.DRAFT`），**不裸写** `'DRAFT'`。
4. 前端色值只来自 `theme.ts` / `--cms-*`；**断点分两层**：页面外壳看视口（`useResponsive()`），
   组件内部看容器（`.cq` + `@container` / `useContainerWidth()`）。
5. 改完必须过 `web build` + `server build` + `npm test`，并**重启后端真打一次请求**（见 §7）。

## 5. 前端约定（速览）

- 新页面用 `perm('/路径', <Page/>)`；后端菜单配了 `permission` 就要在 `ROUTE_PERMISSIONS` 登记**同一权限码**。
- 视觉只改 token 层（`theme.ts`、`index.css` 的 `--cms-*`、`Sider/index.less`），页面/组件里**不写死色值**。
- **断点分两层，别混用**：页面外壳（侧栏/顶栏/内容区边距）看**视口**，走 `useResponsive()`；
  组件内部（卡片内列数、工具条折行、表格密度、弹窗/抽屉里的表单与预览区）看**容器**，
  走 `.cq` + `@container`（规则集中在 `styles/containers.css`），CSS 表达不了的
  （AntD 的 JS prop、ECharts 选项、条件渲染）才用 `useContainerWidth()`。
  **弹窗/抽屉正文本身就是容器**（`.ant-modal-body`），放进弹窗的组件自动按弹窗宽度降级。
- **表格必须声明 `scroll={{ x }}`**；次要列加 `className: 'col-secondary'`（容器窄时自动收起）；
  紧凑行高与冻结关键列由 `ModuleListPage` 按容器给；`≤md` 侧栏走 Drawer。
- ⚠️ 集合了 `container-type` 的祖先会成为其后代 `position: fixed` 的**包含块** → 自绘浮层走 portal；
  且**portal 切换不会重挂载组件**，"外部值 → DOM" 的 effect 依赖要带上挂载点状态。
- 两套测试别混用；前端纯逻辑单测放 `server/test/*.spec.mts`（**不引入** jest/vitest）。
- 细则见 [.claude/rules/frontend-conventions.md](.claude/rules/frontend-conventions.md)、
  [.claude/rules/testing.md](.claude/rules/testing.md)；视觉规则与取舍见 [DESIGN.md](DESIGN.md)。

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
cd server && npm test          # node:test 纯函数单测（30 个 spec，无 DB）
cd server && npm run test:int  # DB 集成测试（5 个 spec，需 DATABASE_URL 指向测试库）
```

> **工具与本机操作要点**（判成败看退出码、临时文件别放 `/tmp`、`MSYS_NO_PATHCONV=1`、SSH 推送、
> Prisma 非交互生成迁移、CDP 真渲染细节）见 [docs/development.md](docs/development.md) §9。

## 7. 验收铁律（改完必做，做完才算完工）

1. `cd web && npm run build`、`cd server && npm run build` 均须通过。
   ⚠️ **别用 `grep "error TS"` 判断 `nest build` 成败**（Nest 输出带 ANSI 颜色码，会漏判）：
   看退出码，或直接跑 `npx tsc --noEmit`。
2. `cd server && npm test` 须全绿（30 个 spec，无 DB）——该 job 已进 CI 门禁（`build` 依赖 `test`，红则不发镜像）。
   spec 数量与清单由 `docStats.spec.mts` 锁定，**新增 spec 必须同步 `docs/development.md §5` 清单**。
   **改金额判定 / 状态流转 / 导入相关代码必须另跑 `npm run test:int`**（5 个 spec：金额闸门 / 合同状态流转 /
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
| [.claude/rules/](.claude/rules/) | **规则细则（按需加载**，不自动读）：`backend-conventions` / `procurement-and-tender` / `import-and-templates` / `frontend-conventions` / `testing` |
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
| [README.md](README.md) | 部署与运维（Docker/NAS/CI） |

> **编号有缺号说明（08 / 09 为已交付的方案类文档，落地后按惯例删除）**：
> - **`docs/08`（全局响应式改造方案）**：V1/V2 全部落地 → 当前口径已固化在 [DESIGN.md](DESIGN.md) §10（双层模型）
>   与 `.claude/rules/frontend-conventions.md`，机器可查的契约在 `server/test/containerQuery.spec.mts`。
> - **`docs/09`（外部重构方案评估与采纳建议）**：评估出的缺口已全部实施或转为"不做"（见 §1「已定的产品口径」），
>   唯一未实施的「清单项级结算明细」已转入 [TODO.md](TODO.md)「可直接开工」。
> - 两者的沿革与逐次验收记录见 `git log`。

> **技术选型**：数据库只有 **PostgreSQL 16**（Prisma + 迁移；**禁 `prisma db push`**，CI 有静态与 diff 两道门禁）。
> 以代码与本文档为准。

> **统计数字的两种待遇**：**活文档**（本文件、`docs/development.md`）里的 spec / model / 业务模块 /
> 增量迁移 计数必须与代码一致，由 `docStats.spec.mts` 锁定；**历史报告**（docs/07 §0.1、
> `docs/07` §0.1 等带日期的记录）是"当时快照"，就地标注即可，**不要**追改。**断言数不进散文**
> （它随用例增减，以 `npm test` 输出为准）。
