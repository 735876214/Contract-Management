# CMS MCP 服务端（`mcp/`）

让**外部 AI**（Claude Desktop / Cursor / 任意 MCP 客户端）通过
[Model Context Protocol](https://modelcontextprotocol.io) 对本合同管理系统做
**查询 / 导出 / 导入**。

## 这是什么

一个**独立的** Node 包，是 MCP 协议与既有 `/api` 之间的一层薄适配器：

```
外部 AI ──MCP(stdio / Streamable HTTP)──> mcp/ ──HTTPS + JWT──> CMS 后端 /api ──> PostgreSQL
```

设计原则：

- **不复制业务逻辑、不直连数据库**。每个工具最终都调用后端既有 REST 接口，
  因此自动继承 JWT 鉴权、RBAC 权限码与 `x-project-id` 项目隔离——和前端用的是同一套边界。
- **与主工程解耦**。不打进 `server`/`web` 的构建，不改 Prisma、不新增迁移、不触碰模块边界检查。
- **读写分离清晰**：查询类工具只读；导入类工具走后端两阶段导入（`validateOnly` 可先预校验不写库）。

## 快速开始

```bash
cd mcp
npm install
npm run build

# 直接跑（stdio，从环境变量取后端地址与账号）
CMS_BASE_URL=http://localhost:3000/api \
CMS_USERNAME=admin CMS_PASSWORD=你的口令 \
node dist/index.js
```

或起 HTTP 模式（多客户端可连，无状态）：

```bash
# 默认仅监听 127.0.0.1；设置 CMS_MCP_HTTP_TOKEN 后客户端需带 Bearer 头
CMS_MCP_HTTP_TOKEN=换成强随机串 node dist/index.js --http 8787
# 端点：http://127.0.0.1:8787/mcp （POST/GET/DELETE，需 Authorization: Bearer <token>）
```

> ⚠️ HTTP 模式等价于「以本机 MCP 身份读写本系统数据」的通道：
> - 默认只监听 `127.0.0.1`，仅本机可连；
> - 监听非回环地址（`CMS_MCP_HTTP_HOST=0.0.0.0`）时**必须**设置 `CMS_MCP_HTTP_TOKEN`，否则拒绝启动；
> - 客户端请求时带 `Authorization: Bearer <token>` 或 `x-mcp-token: <token>`。

## 接入 MCP 客户端

在客户端的 MCP 配置里加一个 server（以 Claude Desktop `claude_desktop_config.json` 为例）：

```jsonc
{
  "mcpServers": {
    "cms": {
      "command": "node",
      "args": ["C:/绝对路径/Contract-Management/mcp/dist/index.js"],
      "env": {
        "CMS_BASE_URL": "http://localhost:3000/api",
        "CMS_USERNAME": "admin",
        "CMS_PASSWORD": "你的口令",
        "CMS_PROJECT_ID": "可选，默认项目 id"
      }
    }
  }
}
```

远端部署时改用 HTTP 模式，客户端填 `http://<host>:8787/mcp`。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CMS_BASE_URL` | ✅ | 后端基地址，含 `/api`，如 `http://localhost:3000/api` |
| `CMS_USERNAME` / `CMS_PASSWORD` | 二选一 | 登录换 token；token 过期自动重登 |
| `CMS_TOKEN` | 二选一 | 预签发 JWT（优先于账号密码） |
| `CMS_PROJECT_ID` | 否 | 默认项目上下文，可被工具参数 `projectId` 覆盖 |
| `CMS_EXPORT_DIR` | 否 | 导出/下载落盘目录，默认 `<cwd>/exports` |
| `CMS_TIMEOUT_MS` | 否 | 单次请求超时，默认 `30000` |
| `CMS_MCP_HTTP_PORT` | 否 | `--http` 模式端口，默认 `8787` |
| `CMS_MCP_HTTP_HOST` | 否 | `--http` 监听地址，默认 `127.0.0.1`；设 `0.0.0.0` 对外时必须配 Token |
| `CMS_MCP_HTTP_TOKEN` | HTTP 模式建议 | Bearer Token 鉴权；未设时仅回环可访问，非回环则拒绝启动 |
| `CMS_MCP_PERMISSION_FILTER` | 否 | 默认开启工具级权限过滤；设 `off` 关闭，退回「由后端 1403 报错」 |

## 工具一览

| 工具 | 作用 |
|---|---|
| `cms_list_resources` | 列出全部资源与各自支持的能力（查询/导出/模板/导入、是否需项目） |
| `cms_whoami` | 当前登录用户、权限码、可访问项目 |
| `cms_query` | 按资源查询列表（`page`/`pageSize`/`keyword`/`filter`） |
| `cms_get` | 按资源 + id 查询单条详情 |
| `cms_export` | 导出 Excel 到本地导出目录，返回绝对路径 |
| `cms_download_template` | 下载导入模板到本地导出目录 |
| `cms_export_contract_word` | 按合同 id 导出 Word |
| `cms_import` | 导入 Excel（multipart）；`validateOnly=true` 只预校验不写库 |

插件还会自带工具：`plugin.json` 的 `mcpTools` 经 `scripts/gen-plugins.mjs` 校验（**只允许 GET**、
权限 ⊆ 插件声明、path 必须是控制器里真实存在的 `@Get`）后生成为 `src/generated/plugin-tools.generated.ts`，
启动时与核心工具一起注册。示例插件 `dev-example` 就带两个（`dev_example_summary` / `dev_example_permissions`）。

支持的资源：`projects` / `suppliers` / `contracts` / `materials` / `contract-materials` /
`daily-reports` / `assets` / `settlements` / `payments` / `invoices` / `ledger` /
`repayments` / `procurement-tasks` / `dict`。各资源能力见 `src/resources.ts`（单一事实源）。

### 工具级权限（按账号过滤）

每个资源在 `src/resources.ts` 里声明 `permissions: { read, write }`，值照抄后端 controller 的
`@RequirePermissions`（多处是 **OR** 语义，例如台账 `ledger:view` **或** `contract:view`）。
于是：

- `cms_list_resources` 只列出**当前账号真能操作**的资源，并把被挡掉的资源放进 `hiddenByPermission`
  ——不列出来的同时说明「被挡住了」，避免 AI 误以为系统里没这些数据；
- 每次调用前先本地判定，无权时给出**可解释**的错误（缺哪个权限码、找谁要），
  而不是让模型对着后端 `1403` 自己猜；
- **本地过滤只是 UX，不是安全边界**：真正的边界仍在后端每个接口，
  项目隔离（`x-project-id` + `ProjectMember`）照旧生效——权限通过不等于能跨项目看数据。

若某部署的角色体系与本仓默认权限码不一致，可用 `CMS_MCP_PERMISSION_FILTER=off` 关掉本地过滤，
退回「由后端 1403 报错」的行为，不会丢功能。

### 口径上下文（MCP resources）

除工具与提示词，还注册了 3 个**只读资源** + 1 个资源模板，让外部 AI 知道「字段值是什么意思」：

| uri | 内容 |
|---|---|
| `cms://context/statuses` | 所有 status 字段的合法取值 + **不计入统计的状态** + 字典类型清单 |
| `cms://context/procurement-flow` | 采购任务类型、固定阶段链（前一阶段未发布后续不可编辑）、阶段↔状态 |
| `cms://context/metrics` | 每个金额/数量指标的唯一实现、owner 与口径说明（含关键排除项） |
| `cms://dict/{typeCode}` | 字典项 `code → 中文标签`（状态码的中文标签在库里，不在代码里） |

为什么需要：AI 拿到 `status: 'PARTIAL'`、`execStatus: 'DONE_UNSETTLED'` 会按自己的理解解释，
于是出现「把失败付款算进累计付款」「自己给采购任务编一个阶段顺序」「把台账合同额当成看板合同额」。
这些不是幻觉，是**缺口径**——系统里有唯一答案，只是没告诉它。

实现边界：正文由服务端 `GET /api/ai/context/:key` 下发（`server/src/modules/ai/context-catalog.ts`），
而那份文档本身又由 `server/src/constants/{statuses,procurementFlow,metrics}.ts` **生成**——
常量改了文档自动跟着变，不存在第二份手写稿。`server/test/aiContext.spec.mts` 锁住「常量里每一项都要出现在文档里」。

推荐用法：**先读这三份资源，再调工具取数**。这比让模型自己猜状态码含义可靠得多。

### 口径提示词（MCP prompts）

除上面这些工具外还注册了 3 个 **MCP prompt**，把系统内的**口径原文**给外部 AI 复用：

| prompt | 作用 | 参数 |
|---|---|---|
| `cms_report` | 写汇报材料的口径 + 公文骨架 | `kind`（monthly/project/brief）、`extra` |
| `cms_payment_anomaly` | 结算/付款异常预警的红线 | — |
| `cms_supply_chain` | 供应链运营全景的红线与四节固定结构 | — |

为什么需要：外部 AI 不知道本企业口径时会「自己算合计」「编造增长率」「没命中的当成没问题」。
这些红线系统内的 prompt 早就写死了，通过 MCP 暴露出去即可让外部 AI 用**同一份原文**。

实现边界：`src/prompts.ts` **只声明结构**（key/标题/参数），正文一律向服务端取
（`GET /api/ai/prompts/:key`，单一事实源在 `server/src/modules/ai-insight/prompt-catalog.ts`）。
所以系统更新口径后，外部 AI 下次 `prompts/get` 自动拿到新版本，本包不必跟着发版。
权限走后端 `ai:view`：没有该权限时 `prompts/get` 返回可读的 1403。

## 测试

```bash
cd mcp
npm test          # 构建 + 纯函数单测 + stdio/HTTP 协议冒烟（无需后端）
node test/e2e.mjs # 端到端（需后端在线 + 种子账号，真跑登录/查询/导出/模板/导入预校验）
```

## 目录

```
mcp/
├── src/
│   ├── config.ts       # 环境变量 → 配置
│   ├── resources.ts    # 资源目录（路径/能力/所需权限码，单一事实源）
│   ├── prompts.ts      # 口径提示词的结构声明（正文向服务端取）
│   ├── context.ts      # 口径上下文资源（状态码/采购工作流/指标口径 + 字典模板）
│   ├── cms-client.ts   # 登录/信封解包/项目头/二进制下载/multipart 上传
│   ├── server.ts       # 核心工具的注册（插件工具在 generated/ 下）
│   └── index.ts        # 入口：stdio 默认 / --http 模式
├── test/               # unit + smoke + http + e2e
└── .env.example
```

## 调用审计

本进程发出的每个 `/api` 请求都会带 `x-cms-actor: mcp` + `x-cms-tool: <工具名>`，
后端据此写操作日志的 `actorTool` 列（人工操作为空）。**包含纯查询工具**——
它们原本一条日志都不留。查「谁让 AI 干了什么」：系统管理 → 日志 → 来源 = `AI / MCP 调用`
（接口 `GET /api/system/logs/operations?actor=mcp`，或按工具名 `?actorTool=cms_query`）。

注意：
- 头由 `cms-client.ts` 的 `headers()` **统一注入**，工具名走 `AsyncLocalStorage`，
  所以新增工具只要走 `server.ts` 里的 `tool()` 注册包装就会自动带上；
- 绕过 `tool()` 直接调 `server.registerTool` 注册的工具**不会被标为 AI 操作**
  （`server/test/mcpAudit.spec.mts` 会拦住这种写法）；
- 审计记录在**后端**（PostgreSQL），不在本包；本包不留任何调用历史。

## 安全提示

- 账号请使用**最小权限**的专用账号（只授 `*:view` 或按需 `*:edit`），不要用超级管理员跑对外 AI。
- 导入（`cms_import`）会写库，请先用 `validateOnly=true` 预校验；后端本身是「全成功或全失败」两阶段导入。
- `CMS_TOKEN`/密码属于机密，勿提交进仓库；`mcp/exports/` 已加入 `.gitignore`。
