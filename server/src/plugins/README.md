# 构建期插件（B 档）

> 一句话：**插件 = 一份清单 + 一个后端模块 + 一个前端页面 + 菜单 + 权限码，全部在构建期装配。**
> 不是运行时热插拔，也不支持上传 zip。

## 1. 为什么是这个形态

参考项目 ApeAdmin 的插件系统是**运行时热插拔**（Python `importlib` + 独立 SQLAlchemy MetaData + 上传 zip 即时生效）。
那套东西搬到本仓会在四个硬约束上撞墙：

| 约束 | 运行时插件在本仓的后果 |
|---|---|
| NestJS 全量编译 + 装饰器元数据编译期固定 | 没有运行时模块加载；动态 `require` 编译产物等于绕过类型与构建 |
| Prisma 单 schema / 单 Client 生成物 | 插件加表必须改 `schema.prisma` + `generate` + 迁移，**运行时不可能完成** |
| 5 个静态门禁检查器（模块边界 / 查询上限 / 事务边界 / body 白名单 / 导入完整性） | 运行时加载的代码**拿不到任何一项保护** = 门禁外挂 |
| 4 个漂移锁 spec（权限目录 / 菜单路由 / 指标口径 / 活文档计数） | 插件自由注册菜单与权限码，与本仓「单一事实源 + 锁」直接冲突 |

所以这里**只保留插件的语义**（清单、版本、依赖、权限前缀、菜单所有权、启停、审计），
去掉**形态**（运行时加载、独立元数据、zip 热装）。代价是启停要重启后端；收益是插件代码与手写代码
享受**完全相同**的门禁与锁——这正是「插件在门禁外」这个最大风险的解法。

## 2. 目录结构

```
server/src/plugins/
├── README.md                     # 本文件（规范）
├── index.ts                      # 对外门面
├── plugin-catalog.ts             # 运行期投影：启用判定 / 依赖校验 / 菜单隐藏（纯函数）
├── plugin-modules.ts             # 唯一把插件 Nest 模块交给 AppModule 的地方
├── generated/                    # ⚠️ 生成物，勿手改
│   ├── plugin-catalog.generated.ts    # 清单投影（纯数据，可被 .mts 单测直接加载）
│   └── plugin-modules.generated.ts    # 唯一 import 插件模块类的地方
└── dev-example/                  # 示例插件（照抄这个目录起步）
    ├── plugin.json               # 唯一事实源
    ├── index.ts                  # 门面：export { DevExampleModule }
    ├── dev-example.module.ts
    ├── dev-example.controller.ts
    └── dev-example.service.ts

web/src/plugins/
├── generated/plugin-catalog.generated.ts   # 同数据的 web 投影
└── dev-example/index.tsx                   # 页面（default export）
```

## 3. `plugin.json` 字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | ✅ | `^[a-z][a-z0-9-]{1,30}$`，**必须等于目录名**，不得与 `server/src/modules/` 下任何模块撞名 |
| `displayName` / `description` / `author` | ✅ | 非空；不得含单引号或换行（会破坏生成物字面量） |
| `version` | ✅ | `x.y.z` |
| `enabledByDefault` | ✅ | 布尔；`false` 的插件即使代码在仓里也不装配 |
| `dependencies` | ✅ | 形如 `core>=1.1.0`、`other-plugin>=0.2.0`（`core` 指核心版本 = `server/package.json` 的 version） |
| `apiPrefix` | ✅ | 必须等于 `plugin/<name>`，且与控制器的 `@Controller('plugin/<name>')` 一致（生成器校验） |
| `permissions[]` | ✅ | `{ code, name, group }`；`code` 必须以 `<name>:` 开头、只含小写字母与连字符；`group` 是角色配置页的分组名 |
| `menus[]` | ✅ | `{ key, label, icon, path, permission, parent? }`；`permission` **必填**（无权限码的插件菜单对所有登录用户可见）；`icon` 必须已在 `Sider/utils/iconHelper.tsx` 的 `ICON_MAP` 注册；`parent` 必须是核心菜单的**顶层分组 key**（如 `system`），省略则自成一个顶层分组 |
| `mcpTools[]` | ⭕ | `{ name, description }`，`name` 必须以 `<name>_` 开头。仅作**声明**，供插件管理页与后续 MCP 工具目录展示 |

## 3.1 `mcpTools`：把插件能力暴露给外部 AI（2026-11-24）

插件可以在 `plugin.json` 里声明 MCP 工具，由 `scripts/gen-plugins.mjs` 校验后生成
`mcp/src/generated/plugin-tools.generated.ts`，MCP 服务启动时按这份静态清单注册：

```json
"mcpTools": [
  {
    "name": "dev_example_permissions",
    "description": "列出示例插件声明的权限码与分组（只读）。",
    "route": { "method": "GET", "path": "permissions" },
    "permissions": ["dev-example:view"],
    "params": [
      { "name": "group", "type": "string", "required": false, "description": "按分组名精确过滤" }
    ]
  }
]
```

校验规则（任一不满足门禁就红，`pluginMcp.spec.mts` 再兜一层）：

| 规则 | 为什么 |
|---|---|
| `name` 必须是 `^[a-z][a-z0-9_]{2,63}$` 且以 `<插件名>_` 开头（插件名的 `-` 换成 `_`） | MCP 侧工具名唯一，前缀保证插件之间、插件与核心工具（`cms_*`）不撞名 |
| `route.method` **只允许 `GET`** | 写操作（POST/PUT/PATCH/DELETE）按 AI 一期口径暂缓（见 `TODO.md` P3-C）；生成器直接拒绝，不靠人记 |
| `route.path` 必须是控制器里真实存在的 `@Get(...)` | 否则 AI 被导到一个 404，还会被模型解释成「系统没这个能力」 |
| `route.path` 不支持 `:id` 路径参数 | 路径参数要额外处理编码与注入，收益不抵风险；改成查询参数 |
| `permissions` 非空且 ⊆ 本插件 `permissions` | 工具级权限是本项目 MCP 的既定口径（后端 `@RequirePermissions` 仍是最终边界） |
| `params[].type` ∈ `string / number / boolean` | 只映射到查询串，不构造请求体 |

**它不是运行时注册**：MCP 侧只有一份生成好的常量数组，进程里不加载任何插件代码——
这与 ApeAdmin 的 `register_mcp_tools()` 是两种形态，取舍见 §8。想加/改工具：改清单 →
`node scripts/gen-plugins.mjs` → 重新构建 `mcp/`。
## 4. 装配链路

```
plugin.json  ──gen-plugins.mjs──┬─> server/src/plugins/generated/plugin-catalog.generated.ts
                               │      └─> constants/menuTree.ts    (MENU_TREE = 核心 + 插件)
                               │      └─> constants/permissions.ts (PERMISSIONS = 核心 + 插件)
                               │      └─> plugins/plugin-catalog.ts (启用判定 / 依赖校验)
                               ├─> server/src/plugins/generated/plugin-modules.generated.ts
                               │      └─> plugins/plugin-modules.ts ─> app.module.ts (imports)
                               └─> web/src/plugins/generated/plugin-catalog.generated.ts
                                      └─> constants/routePermissions.ts (ROUTE_PERMISSIONS = 核心 + 插件)
                                      └─> components/Sider/menuConfig.ts (MENU_CONFIG = 核心 + 插件)
                                      └─> router.tsx 的 <plugin-lazy> / <plugin-routes> 标记块
```

**生成物入库**（与 `packages/calc` 同一策略）：`server/test/pluginCatalog.spec.mts` 会跑
`node scripts/gen-plugins.mjs --check`，改了清单忘了重新生成 → CI 红。

## 5. 新增一个插件（checklist）

1. `cp -r server/src/plugins/dev-example server/src/plugins/<your-key>`，同样复制 `web/src/plugins/dev-example`
2. 改 `plugin.json`：`name` 与目录名一致、权限码全部改成 `<your-key>:` 前缀、菜单 `permission` 指向自己的权限码
3. 改后端文件为 `<your-key>.{module,controller,service}.ts`，`index.ts` 导出 `<PascalCase>Module`
4. 控制器必须写 `@Controller('plugin/<your-key>')`，每个接口都 `@RequirePermissions('<your-key>:xxx')`
5. 前端页面放 `web/src/plugins/<your-key>/index.tsx`（**default export**）
6. 跑 `node scripts/gen-plugins.mjs`
7. `cd server && npm run build` / `cd web && npm run build` / `cd server && npm test` 三绿

### 插件要加表怎么办

Prisma 是单 schema：插件的表也要写进 `server/prisma/schema.prisma`（约定表名 `<key>_` 前缀），
并**单独出一个迁移目录**（迁移名带插件名，便于按插件回滚）。**不能**用 `prisma db push`。
插件的 service 只能写自己的表——`scripts/check-module-boundaries.mjs` 已把
`server/src/plugins/<key>/` 纳入与 `modules/<名>/` **同等**的归属检查，跨插件/跨模块直写会直接红。

## 6. 启用 / 裁剪

| 手段 | 作用范围 | 是否需要重启 |
|---|---|---|
| `plugin.json` 的 `enabledByDefault` | 出厂默认 | 是（构建期） |
| 环境变量 `CMS_PLUGINS_DISABLED=a,b` | 按客户/部署裁剪 | 是 |
| 依赖不满足（`blockedBy`） | 自动 fail-closed，管理页显示原因 | — |

未启用的插件：**Nest 模块不挂载**（路由 404）+ **菜单在运行期被过滤**（`hiddenPluginMenuKeys()`，
超管也看不到）+ **权限码仍然存在**（角色配置页可见，便于提前授权）。三件事走同一个判断入口
`isPluginEnabled()`，不会出现「模块挂了但菜单还在」的半启用状态。

### 为什么没有 enable/disable 接口

ApeAdmin 那套 `PUT /plugins/{id}/toggle` 的前提是有**运行时资源卸载与失败回滚**
（它追踪 route/tool/event 三件套差集，卸载失败还能退回旧实例）。本仓没有那个运行时，
给 UI 一个「一键启停」按钮只会制造「点了但没生效」的误判，所以管理页**只读**。
要做热切换，前置条件是先实现卸载与回滚，而不是先加一个 PUT。

## 7. 与门禁的关系（重要）

插件目录**不是**门禁的白名单豁免区：

| 门禁 | 对插件的效果 |
|---|---|
| `check-module-boundaries.mjs` | `plugins/<key>/` 与 `modules/<名>/` 同等对待：必须走 `index.ts` 门面、不得深层引别家 service、不得写别人的表、不得成静态环 |
| `check-query-limits.mjs` / `check-tx-boundaries.mjs` / `check-body-whitelist.mjs` / `check-import-integrity.mjs` | 扫描面是 `server/src` 全域，插件自动被覆盖 |
| `permissionCatalog.spec.mts` | 插件控制器里的 `@RequirePermissions` 也算「有人用」，插件权限码不会被判成孤儿码 |
| `routePermissionParity.spec.mts` | 插件菜单与前端兜底菜单同源同序（都吃同一份生成物） |
| `pluginCatalog.spec.mts` | 生成物新鲜度 + 权限码前缀 + 菜单/路由/守卫三方一致 + 启用语义 |

## 8. 与 ApeAdmin 的取舍对照

| ApeAdmin 做法 | 本仓取舍 | 理由 |
|---|---|---|
| `plugin.json` 清单 + 版本 + 依赖约束 | ✅ 照抄 | 清单驱动是对的，且天然适配生成器 |
| 依赖校验 + 被依赖时拒卸载 | ✅ 保留（启动期） | 校验时机从「启停时」前移到「启动时 + CI」 |
| 7 个生命周期钩子 | ⚠️ 降级为构建期装配 | `install/uninstall` 在 Prisma 下无法运行时完成 |
| 运行时注册路由/工具/事件 + 差集追踪卸载 | ❌ 不做 | 需要运行时模块加载，与 NestJS 编译模型冲突 |
| 独立 SQLAlchemy MetaData（表隔离） | ❌ 改为表名前缀 + 迁移目录约定 | Prisma 单 schema，隔离要靠约定 + 归属检查 |
| 菜单三前缀模糊匹配 + `is_core_dashboard` 硬编码例外 | ❌ 改为清单**显式声明** `menus[]` | 模糊匹配是「没有单一事实源」的代价，本仓有 `menuTree.ts` |
| 上传 zip 热装（zip bomb / 路径穿越校验） | ❌ 不做 | 上传即执行 = RCE；单租户内部系统没有第三方生态 |
| 升级/降级守卫 + 保留 2 个版本备份 + 失败回滚 | ❌ 交给 git + 镜像回滚 | 有 `version` 字段可查；回滚不该由业务进程做 |
| `POST /plugins/restart`（`os._exit` 重启进程） | ❌ 不做 | 给 Web 一个进程重启入口就是 DoS 面；交给 Compose / 运维 |
| 独立 `sys_mcp_audit_log` 表 | ❌ 复用 `OperationLog` | 本仓操作日志已含 module/action/bizType/duration/result |

## 9. 已知边界

- **启停需重启**：构建期插件的固有代价，已在插件管理页写明。
- **代码在产物里**：禁用只影响装配，不影响打包体积（前端页面仍会被 vite 打进 chunk）。
  若某插件长期不用，应删目录而不是长期禁用。
- **权限码不会随禁用消失**：角色里已授予的插件权限会保留，重新启用即恢复。
- **没有插件市场/在线升级**：本仓的升级就是发版。
