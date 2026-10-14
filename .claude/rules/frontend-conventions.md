# 前端约定细则

> **何时加载**：改动 `web/src/**`（页面、组件、样式、路由、store、utils）时。

## 路由与权限

- **路由懒加载 + 路由级权限守卫**：`web/src/router.tsx` 全部页面 `React.lazy`；页面元素统一走
  `perm(path, <Page/>)` 工厂，按 `constants/routePermissions.ts` 自动包 `RequirePermission`（403 页，不重定向）。
- **新增页面必须**：① 用 `perm('/新路径', <Page/>)` 而非裸元素；② 若后端 `menuTree.ts` 给该菜单项配了
  `permission`，必须在 `ROUTE_PERMISSIONS` 登记**同一权限码**——`routePermissionParity.spec.mts` 会校验，
  且**守卫不得比菜单更严**（否则出现「菜单可见、点进去 403」）。有意不守卫的路径登记进
  `ROUTE_PERMISSION_EXCEPTIONS`（现有 `/dashboard`，默认落地页）。
- **菜单权威来源是后端** `GET /api/menu`（`server/src/modules/system/menu.service.ts` 的 `MENU_TREE`）——
  只改前端 `Sider/menuConfig.ts` 无效（它只是接口失败时的兜底）。新增图标要在
  `Sider/utils/iconHelper.tsx` 的 `ICON_MAP` 注册；改菜单结构后递增 `Sider/utils/storage.ts` 的缓存键版本。
- **旧扁平路径改为重定向保号**：旧路径（`/projects`、`/ledger`、`/daily` …）通过 `<Navigate replace />`
  跳到 Sider 新规范路径；例外：`/contracts`（合同编辑页）保留为真实路由，去留待业务确认。

## 视觉 token（换肤只改一处）

- token 层只有三处：`web/src/theme.ts`（色板/语义色/图表配色/antdTheme）、`index.css` 的 `--cms-*`（CSS 镜像）、
  `components/Sider/index.less`（LESS 用不了 `var()`）。
- **页面/组件里不许写死 `#hex` / `rgb()`**——由 `themeTokens.spec.mts` 锁定；白名单只有
  `RichTextEditor.tsx`（编辑器调色板是功能）与 `utils/docExport.ts`（Word 内联样式，Word 不认 CSS 变量）。
- 状态色**不重命名**：字典 `dict_item.color` 与 `TASK_STATUS_COLORS` 里是 `blue/green/orange…` 这类语义名，
  且是**前后端镜像常量**；换视觉在渲染层映射（`theme.PRESET_TONE_MAP` + index.css 的
  `.ant-tag.ant-tag-<name>` 覆盖，特异度要 ≥0,2,0 才压得住 AntD 运行时注入的样式）。
- 改视觉前读 [DESIGN.md](../../DESIGN.md)（§0 写了"移植了什么、不搬什么"，含**不搬 Anthropic 商标**）。

## 响应式

- **断点唯一来源是 `useResponsive()`**（`web/src/hooks/useResponsive.ts`）：**禁止**组件内用
  `window.innerWidth` / `matchMedia`。四条硬性约定（Col 带断点、Table 声明 `scroll`、弹窗宽度可被全局兜底、
  ≤md 侧栏走 Drawer）见 DESIGN.md §10。

## 列表页列显隐（两条路别混用）

- ① 通用列表页 `ModuleListPage.columnConfigKey`：偏好存 **localStorage**，纯逻辑在 `utils/listColumns.ts`；
- ② 合同台账 `Ledger` 的 `ledger.columns.config`：**服务端共享**配置，页面列也由后端返回。
- 给台账页再传 `columnConfigKey` 会出现两套列设置打架；列显隐**不落 `sys_param`**（那是全局配置且需
  `system:config` 权限，普通用户存不了）。
