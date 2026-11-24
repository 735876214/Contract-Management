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

支持的资源：`projects` / `suppliers` / `contracts` / `materials` / `contract-materials` /
`daily-reports` / `assets` / `settlements` / `payments` / `invoices` / `ledger` /
`repayments` / `procurement-tasks` / `dict`。各资源能力见 `src/resources.ts`（单一事实源）。

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
│   ├── resources.ts    # 资源目录（路径/能力，单一事实源）
│   ├── cms-client.ts   # 登录/信封解包/项目头/二进制下载/multipart 上传
│   ├── server.ts       # 8 个工具的注册
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
