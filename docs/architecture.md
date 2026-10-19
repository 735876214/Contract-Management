# 架构与数据流（Architecture）

> 面向开发者：系统的分层、模块、请求生命周期、鉴权与隔离、数据模型、关键工作流与部署形态。
> 组件级接口见 [component-api.md](component-api.md)；操作说明见 [user-guide.md](user-guide.md)。

## 1. 总体形态

```
┌──────────────────────────── 浏览器 ────────────────────────────┐
│  React 18 SPA (web/)                                           │
│  AntD 5 + Zustand + ECharts + axios                            │
└───────────────┬────────────────────────────────────────────────┘
                │ HTTPS/HTTP  /api/*   (Authorization: Bearer, x-project-id)
┌───────────────▼────────────────────────────────────────────────┐
│  nginx (部署态，容器内)  ── 静态资源 + /api 反代 ──┐            │
└──────────────────────────────────────────────────┼─────────────┘
                                                   ▼
┌──────────────────── NestJS 10 (server/) ───────────────────────┐
│  Controller ─ 守卫(JWT/RBAC) ─ 管道(ValidationPipe)            │
│      └─ Interceptor(统一响应 / 操作日志) ─ Service ─ Prisma     │
│  22 个业务模块 + common 通用层 + constants 单一事实源           │
└───────────────┬────────────────────────────────────────────────┘
                │ Prisma Client
        ┌───────▼────────┐
        │  PostgreSQL 16 │   卷 = NAS 数据目录（bind mount）
        └────────────────┘
```

- 开发态无 nginx：Vite dev server 把 `/api` 代理到后端（`VITE_PROXY_TARGET`，默认 `http://localhost:3000`）。
- 部署态**单容器**：nginx 托管前端静态产物，并把 `/api/` 反代到同容器 `127.0.0.1:3000`，
  由 `deploy/single/start.sh` 同时拉起后端与 nginx。

## 2. 后端分层

### 2.1 目录

```
server/src/
├── main.ts                 # bootstrap：CORS / 全局前缀 / 管道 / 拦截器 / 过滤器 / 静态资源 / 启动 seed
├── app.module.ts           # 装配 ConfigModule + PrismaModule + CommonModule + 22 业务模块
├── prisma/                 # @Global PrismaModule（PrismaClient useFactory）
├── common/                 # 通用层（见 §2.2）
├── constants/              # procurementFlow.ts（采购工作流）· workflowGuards.ts（驳回守卫）
└── modules/                # 业务模块（见 §2.3）
```

### 2.2 通用层 `common/`

| 成员 | 职责 |
|---|---|
| `interceptors/response.interceptor.ts` | 统一响应 `{ code:0, data, message:'ok', timestamp }`；请求头 `x-raw-response:1` 时跳过包装（用于返回打印就绪 HTML） |
| `interceptors/operation-log.interceptor.ts` | 拦截 POST/PUT/PATCH/DELETE，按 `ROUTE_MAP` 写操作日志（记变更前后快照、导入统计、密码脱敏、字段截断） |
| `filters/all-exceptions.filter.ts` | 全局异常 → `{ code, data:null, message }`；状态码映射 500→1500、401→1401、403→1403、400→1001 |
| `decorators/` | `@Public()` · `@RequirePermissions(...)` · `@CurrentUser()` · `@ProjectId()` · `@ClientIp()` |
| `services/excel.service.ts` | 导出带 logo 表头的 Excel、解析导入 Excel（去 `*`、日期归一） |
| `services/styled-excel.service.ts` / `import-template.service.ts` | 带样式导出 / 生成填写模板（`TEMPLATE_MAX_ROWS=5000`） |
| `services/import-runner.service.ts` | **两阶段导入**：全量校验出写入计划 → 全通过才在 `$transaction` 内写入（全成功或全失败） |
| `services/import-task.service.ts` / `import-task.controller.ts` | 异步导入（>1000 行返回 taskId，进度轮询、失败行错误报告、完成发站内信） |
| `services/sys-param.service.ts` | 系统参数（内存缓存，`refresh` 重载）：编号唯一性、供应商共享范围、台账列配置等 |
| `services/log.service.ts` | 写操作/登录日志（失败不阻断业务） |
| `pick-fields.ts` | `pickFields(data, allowed)` 白名单过滤，防前端字段漂移导致 500 |
| `utils/money.ts` | `amountToChineseCapital()` 金额大写、`round/round2/round4`（模拟 Excel 舍入） |
| `utils/helpers.ts` | `paginate`(上限 500) · `buildResult` · `assertVersion`(乐观锁 409) · `assertImportRows` · `num/sum/toDate` |
| `utils/docx-patch.ts` | 给生成的 Word 注入页眉/页脚/页码 |

### 2.3 业务模块（22 个）

| 模块 | 控制器前缀 | 主要实体 | 权限守卫 |
|---|---|---|---|
| `auth` | `auth` | User/Role/Permission | 仅 JWT（`@Public` 放行 login） |
| `system` | `system` · `menu` | User/Role/Permission/SysParam/Log | JWT |
| `project` | `projects` | Project/ProjectMember | JWT + 权限 |
| `dict` | `dict` | DictType/DictItem | JWT + 权限 |
| `supplier` | `suppliers` | Supplier | JWT + 权限 |
| `subcontractor` | `subcontractors` | Subcontractor | JWT + 权限 |
| `contract` | `contracts` | Contract/Ext/Attachment/ChangeLog/物料 | JWT + 权限 |
| `template` | `templates` | ContractTemplate/TemplateVariable/Clause | JWT + 权限 |
| `material` | （无前缀）`materials` · `contract-materials` | MaterialBase/ContractMaterial/Pool/Draft | JWT + 权限 |
| `daily-report` | `daily-reports` | DailyReport | JWT + 权限 |
| `receipt-order` | `receipt-orders` | ReceiptOrder/Detail | JWT + 权限 |
| `settlement` | `settlements` | Settlement/SettlementLedger | JWT + 权限 |
| `payment` | `payments` | PaymentRecord | JWT + 权限 |
| `invoice` | `invoices` | Invoice | JWT + 权限 |
| `ledger` | `ledger` | （聚合视图，无表） | JWT + 权限 |
| `repayment` | `repayments` | RepaymentAgreement/Detail | JWT + 权限 |
| `finance` | `finance` | FactoringCost/OverdueInterest | JWT + 权限 |
| `asset` | `assets` | AssetLedger | JWT + 权限 |
| `procurement` | `procurement-tasks` · `procurement-templates` | ProcurementTask + 各阶段子表 | JWT + 权限 |
| `dashboard` | `dashboard` | （聚合，无表） | 仅 JWT |
| `notification` | `notifications` | Notification | 仅 JWT |
| `file` | `files` | （无表） | 仅 JWT |

> 守卫**非全局注册**，逐 controller `@UseGuards(JwtAuthGuard, PermissionsGuard)` 声明。

## 3. 请求生命周期

```
HTTP 请求
  → main.ts 全局前缀 /api + ValidationPipe(whitelist, transform)
  → Guard: JwtAuthGuard（校验 Bearer / ?token=，检查 user.status；@Public 放行）
           PermissionsGuard（读 @RequirePermissions；superAdmin 直通；否则 OR 语义校验权限码）
  → Controller（@ProjectId() 取项目上下文 → 调 Service）
  → Service（pickFields 白名单 → Prisma 查询，where 带 projectId → assertVersion 乐观锁）
  → Interceptor: OperationLogInterceptor（写操作留痕，先取 before 快照）
  → Interceptor: ResponseInterceptor（包装 { code, data, message, timestamp }）
  → 异常：AllExceptionsFilter → { code, data:null, message }
```

### 3.1 统一返回与错误码

- 成功：`{ code: 0, data, message: 'ok', timestamp }`
- 失败：`{ code, data: null, message }`，常见码：
  `1001` 参数错误 · `1401` 未登录 · `1403` 无权限 · `1500` 服务端异常 · `409` 乐观锁冲突

### 3.2 前端消费约定

[web/src/api/http.ts](../web/src/api/http.ts)：axios 拦截器在 `code === 0` 时**直接解包返回 `data`**；
否则 `message.error` 并在 `1401` 时清 token、跳登录。故页面 `try/catch` 里通常无需再提示。

## 4. 鉴权与 RBAC

```
User ──< UserRole >── Role ──< RolePermission >── Permission(code: module:action)
```

- 登录：`POST /auth/login` → bcrypt 校验 → 聚合权限码 + 可访问项目 → 写 `LoginLog` → 签发 JWT（`{sub,username}`，默认 7d）。
- `JwtStrategy.validate`：查用户（须 `status===1`）→ 计算权限 → 注入 `req.user`。
- Token 来源：`Authorization: Bearer`（常规）或 URL `?token=`（`window.open` 下载无法带请求头时）。
- 权限码示例：`contract:view`、`settlement:edit`、`system:user`、`finance:view`。
  **OR 语义**：`@RequirePermissions('a','b')` 命中任一即通过；`isSuperAdmin` 绕过全部。
- 前端：`useAuthStore.hasPermission(code)`。作用于两处——
  ① 侧边菜单过滤（`Sider`）；② **路由级守卫**（`router.tsx` 的 `perm()` 包装
  `RequirePermission`，按 `web/src/constants/routePermissions.ts` 判定，无权限渲染 403 页）。
  路由守卫只是体验层，**安全边界仍在后端**。

## 5. 项目隔离（关键机制）

**没有全局中间件强制过滤**——这是本项目最需要警惕的设计：

1. **取值**：`@ProjectId()` 装饰器按优先级取
   `request.projectId` → `headers['x-project-id']` → `query.projectId` → `body.projectId`；
   全缺 → `400 缺少项目上下文（x-project-id）`（明确报错，避免 Prisma 空参 500）。
2. **传递**：controller 显式接收并传给 service。
3. **过滤**：service 在查询 `where` 与写入数据中带 `projectId`。
   使用密度：contract 38 处、settlement 27、receipt-order 27、procurement-task 23、invoice 20……
4. **例外**（代码侧也已在对应 service 顶部显式注释，避免后人"顺手"补过滤）：
   - `dict` 全局共享，不按项目过滤（`dict.service.ts` 顶部注释）；
   - `finance` 按 `contractId` 归属（`contractScope`），不直接按项目（`finance.service.ts` 顶部注释）；
   - `supplier` 受系统参数 `supplier.share.scope` 控制：`GLOBAL`（默认）不过滤且 `projectId=null`；`PROJECT` 按项目过滤；
   - `Subcontractor` / `ContractTemplate` 的 `projectId = null` 表示全局共享。
   完整口径表另见 [docs/03-API接口清单.md](03-API接口清单.md) §0。
5. **前端**：登录后把 `projects[0].id` 写入 `localStorage['cms_project_id']`，
   axios 请求拦截器注入 `x-project-id`；`ProjectSwitch` 切换后 `reload()`。

## 6. 数据模型概览

出处：`server/prisma/schema.prisma`（**52 个 model**，**零 DB enum**——字典驱动，见 CLAUDE.md 铁律 4）。

**通用约定**
- 主键 `id String @id @default(cuid())`；时间 `createdAt`/`updatedAt`。
- 乐观锁：多数业务表含 `version Int @default(0)`。
- 项目隔离：业务表含 `projectId`（Supplier/Subcontractor/ContractTemplate 可空 = 全局共享）。
- 停用/软删：用 `status`（`Int` 1/0 或业务字符串），**无统一 `deletedAt`**。
- 字典字段：一律存**字典项编码字符串**（`xxxCode`），不用数据库枚举。

**领域分组**

| 领域 | Model |
|---|---|
| 组织与权限 | User · Role · Permission · UserRole · RolePermission |
| 项目 | Project · ProjectMember |
| 供应商/分包 | Supplier · Subcontractor |
| 合同 | Contract · ContractExt(1:1) · ContractAttachment · ContractChangeLog · ContractTemplate · TemplateVariable · Clause |
| 物资 | MaterialBase · ContractMaterial · ContractMaterialPool · ContractDraftMaterial |
| 日报 | DailyReport |
| 结算付款 | Settlement · SettlementLedger · PaymentRecord |
| 发票/还款 | Invoice · RepaymentAgreement · RepaymentDetail |
| 资金费用 | FactoringCost · OverdueInterest |
| 资产/收领 | AssetLedger · ReceiptOrder · ReceiptOrderDetail |
| 采购 | ProcurementTask · ProcurementTotalItem · FrameworkExplanation · PreMeetingMinutes · ProcurementNotice · ProcurementDocument · ProcurementResultReport · ProcurementPriceCompare · ProcurementTemplate · InspectionReport |
| 通知与日志 | Notification · OperationLog · LoginLog · ImportTask · ArchiveLog |
| 字典参数 | DictType · DictItem · SysParam |

**关键关系**
- `Project 1—N 几乎所有业务表`（多 `onDelete: Cascade`）。
- `Contract N—1 Project / Supplier`；自关联补充协议链 `SupplementChain(parentContractId)`；
  `N—1 ProcurementTask(TaskContracts)`；`1—1 ContractExt`；下游结算/付款/发票/还款/物资。
- `ProcurementTask 1—N Contract`；`1—N ProcurementTotalItem`；与各阶段子表 `1—1(taskId 唯一)`。
- 台账 `ContractLedger` **不建表**：服务层以 Contract 为主表批量 join 聚合（见 §8）。

## 7. 采购工作流（核心状态机）

**单一事实源**：`server/src/constants/procurementFlow.ts`，前端镜像 `web/src/constants/procurementWorkflow.ts`，
由 `server/test/frontendChainParity.spec.mts` 锁定一致性。

- **采购类型**：`FRAMEWORK` / `SINGLE` / `EMERGENCY`。
- **阶段**：`TOTAL_LIST → PRE_MEETING → NOTICE → DOCUMENT → RESULT_REPORT → PRICE_COMPARE → FRAMEWORK_EXPLAIN`，
  末态 `CONTRACT` 不入链。
- **阶段链**（`stageChain(type, preMeetingRequired)`）：
  - EMERGENCY：`[TOTAL_LIST]`
  - FRAMEWORK：`[TOTAL_LIST, PRICE_COMPARE, FRAMEWORK_EXPLAIN]`
  - SINGLE：`[TOTAL_LIST, (PRE_MEETING 若 ≥100万), NOTICE, DOCUMENT, RESULT_REPORT, PRICE_COMPARE]`
- **门禁**：`stage` = 已发布阶段数；`stageView(chain, stage)` → 已过 `done` / 当前 `editing` / 未及 `locked`。
- **任务状态**：由 stage 推导（`deriveStatus`），如 `_EDITING` / `CONTRACT_APPROVING` / `COMPLETED`。
- **合同类型推导**（`deriveContractType`）：EMERGENCY→紧急；FRAMEWORK→物资 `PURCHASE_EXEC` / 租赁 `LEASE_EXEC`；
  SINGLE→物资 `PURCHASE` / 租赁 `LEASE`。
- **多合同生成**（`resolveContractUnits`）：SINGLE 取成交报告候选人，FRAMEWORK 取事前说明引用供应商；空则回退单份。
- **列表分支**（`moduleStageBranches`）：按「类型 × 有无采前会 × 最小 stage」构造 OR 分支，防不属于该类型的任务混入。

**驳回守卫**（`server/src/constants/workflowGuards.ts`，纯状态回退）：
- 合同签章驳回：仅 `APPROVING`/`SIGNED` 可驳回回合同起草；
- 结算驳回：草稿不可重复驳回；
- 成交报告退回：仅 SINGLE、且已发布、且下游合同为 DRAFT/不存在（防孤儿合同）。

## 8. 合同台账聚合（避免 N+1）

`ledger.service.ts` 以 **Contract 为主表**，批量 join `Supplier`/`ContractExt`，
聚合 `SettlementLedger`/`Invoice`/`PaymentRecord`/`DailyReport` 的汇总值，
再计算**合规性问题**（如未签先进场、时间倒挂、时间不完整）与各项占比、按年汇总。
结果经 `GET /ledger/contracts` 返回 36 列固定顺序视图，列显隐存 `sys_param: ledger.columns.config`。

## 9. 导入数据流

```
上传 Excel → ImportRunnerService：
  ① parse 去表头 * / 归一日期
  ② 全量校验生成写入计划；任一行失败 → 返回错误报告，不写库
  ③ 全部通过 → prisma.$transaction 内一次性 write
行数 ≤1000 → 同步返回；>1000 → 建 ImportTask(PENDING) 立即返回 taskId
           → 后台 RUNNING → SUCCESS/FAILED，失败行生成错误报告 Excel（/api/files/import-errors/…）
           → 完成发站内通知
```

前端 [ImportButton.tsx](../web/src/components/ImportButton.tsx)：菜单 →（可选）预校验 → 确认 → 轮询进度 → 结果汇总；
传入 `validateUrl` 时先跑一次只校验不写库的 `.../import/validate`（恒定同步），有问题行则列出、禁止导入。

## 10. 前端架构

```
web/src/
├── main.tsx → App.tsx(ConfigProvider/AntdApp) → router.tsx(RouterProvider)
├── layouts/BasicLayout.tsx      # Sider + Header(项目切换/消息铃铛/用户) + Content + 面包屑
├── components/                  # 通用组件（Sider 整套、DictSelect、ImportButton、contract/*、procurement/*）
├── pages/                       # 页面（含 Procurement/ 子目录）
├── api/                         # http.ts(axios) + auth/business/dict/modules
├── store/                       # Zustand：auth（登录态/权限/当前项目/系统参数）、dict（字典缓存）
├── constants/                   # procurementWorkflow.ts（镜像后端）、procurementVariables.ts（变量体系）
├── hooks/                       # useTable（通用列表查询）
└── utils/                       # money / docExport / download / procurement*（导出与计算）
```

**数据流（前端视角）**

```
页面 → hooks/useTable 或直接 api/* 调用
     → api/http.ts（注入 Bearer + x-project-id，解包 data，统一报错）
     → 后端
字典：组件 DictSelect/DictTag → store/dict.ensure → /dict/options/batch（内存缓存）
菜单：Sider → useMenuData → GET /api/menu（sessionStorage 缓存 5min，失败兜底本地 MENU_CONFIG）
认证：router RequireAuth → useAuthStore（无 user 时 loadProfile 恢复会话）
```

**现状要点**

- **路由懒加载**：`router.tsx` 全部页面 `React.lazy`，`Suspense` 兜底在 `BasicLayout` 内容区；
  首屏只加载 `index` + `react` + `antd` 三个 chunk，其余页面按需拉取。
- **路由级权限守卫**：`perm(path, <Page/>)` 按 `web/src/constants/routePermissions.ts`
  自动包 `RequirePermission`（无权限渲染 403 页，不重定向；superAdmin 直通）。
  与后端 `MENU_TREE` 的一致性由 `server/test/routePermissionParity.spec.mts` 锁定；
  菜单带权限但有意不守卫的路径登记在 `ROUTE_PERMISSION_EXCEPTIONS`（现有 `/dashboard`）。
  注意：路由守卫只是体验层，**安全边界仍在后端** `@RequirePermissions` + `PermissionsGuard`。
- **旧扁平路径改为重定向保号**（`<Navigate replace />`），不再重复渲染同一组件；
  `/contracts`（旧合同编辑页）无新菜单入口，保留为真实路由。

## 11. 部署拓扑

**生产（`docker-compose.yml`）**

```
postgres:16-alpine (容器 cms-postgres, 卷 = NAS 数据目录 bind mount, healthcheck pg_isready)
        ▲ depends_on service_healthy
cms 单容器 (ghcr.io/735876214/cms-single):
  node:20-slim 内 nginx(8080) ── 静态前端 + /api 反代 127.0.0.1:3000
  后端 Node(3000)，start.sh(tini/PID1; bash wait -n) 任一进程退出即整体退出 → restart 自愈
  对外 9080 → 容器 8080；上传落 NAS 附件目录（bind mount）
```

启动流程 `start.sh`：`prisma generate` → `prisma migrate deploy` → 建上传目录 →
后台起后端 + nginx → `wait -n` 监控。

**数据库初始化**：空库时 `migrate deploy` 应用折叠基线 `20260901000000_init`（一次建全表）；
后端启动自动幂等 seed：`seedAdmin` → `seedDefaultProject` → `seedDictAndParams`。

**CI/CD**：push `main`/`v*` → `.github/workflows/build.yml`（buildx，**仅 linux/amd64**，GHA 层缓存）
→ 公开镜像 `ghcr.io/735876214/cms-single`（tag `latest` + `sha-<sha>`）→ NAS `docker compose pull`。

详见 [development.md](development.md) 与 [../README.md](../README.md)。
