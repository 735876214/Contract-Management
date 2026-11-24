# MCP 接入说明（外部 AI 查询 / 导出 / 导入）

> 面向维护者：为什么要做、怎么做的、边界在哪。使用手册见 [../mcp/README.md](../mcp/README.md)。

## 1. 目标

让外部 AI（Claude Desktop / Cursor / 任意 MCP 客户端）以标准协议访问本系统数据：

- **查询**：项目、供应商、合同、物料、日报、资产、结算、付款、发票、台账、还款、采购任务、字典；
- **导出**：上述资源的 Excel 导出、导入模板下载、合同 Word 导出（落盘为本机文件）；
- **导入**：把本机 Excel 导入指定资源，支持「只预校验不写库」。

## 2. 架构决策：独立 MCP 包（不是塞进 NestJS）

在 `mcp/` 下新增**独立 Node 包**，作为一薄层 MCP↔`/api` 适配器：

```
外部 AI ──MCP(stdio / Streamable HTTP)──> mcp/ ──HTTP + JWT──> server /api ──> PostgreSQL
```

对比「在 NestJS 里内嵌 MCP 端点」，选独立包的理由：

| 维度 | 独立 `mcp/` 包 | 内嵌 NestJS 模块 |
|---|---|---|
| 复用业务规则 | 走既有 REST，天然复用 RBAC、项目隔离、两阶段导入 | 需直接调 service，易越模块边界 |
| 构建/测试门禁 | 不动 `server`/`web` 构建与 `npm test`、集成测试 | 每次改动都要过全量门禁 |
| 模块边界检查器 | 不受 `check-module-boundaries.mjs` 约束 | 需新增模块入口，可能触发 fan-out/环 |
| 部署 | 可与后端同机也可独立部署 | 与后端强绑定，改后端即改 MCP |
| 外部 AI 接入 | 原生 MCP（stdio/HTTP），通用 | 需在业务服务里维护 MCP 生命周期 |

结论：MCP 只调用**公共 API 面**，与「任何外部系统接入」是同一套边界，最省心、最安全。

## 3. 复用即安全

MCP 不直连数据库，所有调用都带 `Authorization: Bearer <token>` 与 `x-project-id`，
因此：

- **权限**：每个接口都有 `@RequirePermissions('module:action')`，账号无权限即返回 `1403`；
- **项目隔离**：`JwtAuthGuard` 按 `ProjectMember` 校验归属，非成员 `1403`、项目不存在 `1404`；
- **统一信封**：`{code,data,message}`，`code!==0` 时 MCP 抛带错误码的可读异常。

建议给外部 AI 配**最小权限专用账号**（只读场景仅 `*:view`）。

**MCP 通道自身的安全**：
- stdio 模式：由本机 MCP 客户端拉起子进程，天然只有本机使用者可连；
- HTTP 模式：默认只监听 `127.0.0.1`；监听非回环地址（`CMS_MCP_HTTP_HOST=0.0.0.0`）**必须**设置
  `CMS_MCP_HTTP_TOKEN`，否则拒绝启动；客户端请求 `/mcp` 需带 `Authorization: Bearer <token>`
  或 `x-mcp-token: <token>`。等价于「以本机 MCP 身份读写系统数据」，对外暴露前务必设强随机 Token。
- `cms_whoami` 会对 `/auth/profile` 返回体做递归脱敏（`apiKey`/`secret`/`password`/`token` 等字段替换为 `***`），
  避免系统参数里的机密透传给外部 AI。后端 `/auth/profile` 的 `params` 建议另行做服务端白名单（纵深防御）。

### 3.1 调用审计（2026-11-24）

**问题**：MCP 的 8 个工具里 4 个是纯 GET 查询（`cms_query` / `cms_get` / `cms_whoami` /
`cms_list_resources`），而 `OperationLogInterceptor` 默认只记写方法与 GET 导出下载——
这 4 个工具**一条日志都不留**；写操作（`cms_import`）虽然记了，但与人工点「导入」
在日志里完全无法区分。于是「AI 查走/导走了什么、谁给的权限」事后答不出来。

**做法**：`mcp/` 发出的每个请求都带两个头（由 `mcp/src/cms-client.ts` 的 `headers()` 统一注入，
工具名通过 `AsyncLocalStorage` 传递，不靠每个 handler 手动拼）：

```
x-cms-actor: mcp
x-cms-tool: cms_query        # 具体工具名
```

后端 `OperationLogInterceptor` 认到这两个头就**无论方法**都记一条，写进
`OperationLog.actorTool`（人工操作为 `null`）。日志页（系统管理 → 日志）多一列「来源」
（`AI · cms_query` / `人工`）和一个「来源」筛选（`actor=mcp` / `actor=human`）。

**为什么单开一列**：`bizType` 有既定语义（模型名/业务类型，被 import-task 回填与前端
「业务类型」列消费），拿它兼职做「谁发起的」会同时毁掉两个含义。

**为什么头名有两份字面量**：`mcp/` 是独立 Node 包，不能 import `server/src`。
所以 `server/src/constants/mcpAudit.ts` 是权威定义，`server/test/mcpAudit.spec.mts`
反向校验 `mcp/src/cms-client.ts` 里确实写着同样的字面量，并断言每个工具都走
`tool()` 包装注册——**两端不一致或漏包都会让审计静默归零**（不报错，只是查不到 AI 操作），
这是这个锁存在的全部理由。

## 4. 资源 → 接口映射（单一事实源：`mcp/src/resources.ts`）

| 资源 key | 列表/详情 | 导出 | 模板 | 导入 |
|---|---|---|---|---|
| projects | `GET /projects` | — | `GET /projects/template` | `POST /projects/import` |
| suppliers | `GET /suppliers` | `GET /suppliers/export` | `…/template` | `…/import` |
| contracts | `GET /contracts` | Word: `GET /contracts/:id/export-word` | `…/template` | `…/import` |
| materials | `GET /materials` | `GET /materials/export` | `…/template` | `…/import` |
| contract-materials | `GET /contract-materials`（需 contractId） | `…/export`（需 contractId） | `…/template`（**不需** contractId） | `…/import`（需 contractId） |
| daily-reports | `GET /daily-reports` | `…/export` | — | `…/import` |
| assets | `GET /assets` | `…/export` | `…/template` | `…/import` |
| settlements | `GET /settlements` | `GET /settlements/ledger/export` | `…/template` | `…/import` |
| payments | `GET /payments/records` | `…/export` | `…/template` | `…/import` |
| invoices | `GET /invoices` | `…/export` | `…/template` | `…/import` |
| ledger | `GET /ledger/contracts` | `GET /ledger/export` | — | — |
| repayments | `GET /repayments` | `GET /repayments/export` | — | — |
| procurement-tasks | `GET /procurement-tasks` | — | — | — |
| dict | `GET /dict/items`（需 typeCode） | `GET /dict/export` | — | `…/import`（需 typeCode） |

> 后端路由改动时，只需同步 `mcp/src/resources.ts` 一处。
> `cms_get`（单条详情）仅对 `resources.ts` 里有 `detailPath` 的资源可用
> （projects / suppliers / contracts / daily-reports / settlements / invoices / repayments / procurement-tasks），
> 其余资源无详情路由，调用会得到明确提示（可用 `cms_list_resources` 的 `canGet` 判断）。

## 5. 工具

见 [../mcp/README.md](../mcp/README.md) §工具一览。8 个工具：`cms_list_resources` /
`cms_whoami` / `cms_query` / `cms_get` / `cms_export` / `cms_download_template` /
`cms_export_contract_word` / `cms_import`。

## 6. 验收

- `cd mcp && npm test`：构建通过 + 4 个纯函数单测 + stdio/HTTP 协议冒烟（无需后端）。
- `cd mcp && node test/e2e.mjs`：需后端在线，实测登录 → 项目/合同查询 → 供应商 Excel 导出（字节数>0）
  → 合同模板下载 → 合同导入预校验，全绿。2026-11-18 本地验证通过。

## 7. 未纳入的范围

- 不做写库的「结构化新增/修改」工具（当前只做 Excel 导入，复用后端既有导入流程与校验）。
  若后续需要按字段增改单条记录，可在 `server` 增加明确的写接口后再在 `mcp` 加薄工具。
- 不做数据库直连、不做跨库联动。
