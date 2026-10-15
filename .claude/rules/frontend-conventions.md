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
- **样式文件也只有这几个 + `styles/containers.css`**（后者只放组件级 CQ 规则，**不持有色值**，
  故不在 `themeTokens` 白名单里；但它同样被色值扫描覆盖，写死 `#hex` 即红）。见 DESIGN.md §9。
- **页面/组件里不许写死 `#hex` / `rgb()`**——由 `themeTokens.spec.mts` 锁定；白名单只有
  `RichTextEditor.tsx`（编辑器调色板是功能）与 `utils/docExport.ts`（Word 内联样式，Word 不认 CSS 变量）。
- 状态色**不重命名**：字典 `dict_item.color` 与 `TASK_STATUS_COLORS` 里是 `blue/green/orange…` 这类语义名，
  且是**前后端镜像常量**；换视觉在渲染层映射（`theme.PRESET_TONE_MAP` + index.css 的
  `.ant-tag.ant-tag-<name>` 覆盖，特异度要 ≥0,2,0 才压得住 AntD 运行时注入的样式）。
- 改视觉前读 [DESIGN.md](../../DESIGN.md)（§0 写了"移植了什么、不搬什么"，含**不搬 Anthropic 商标**）。

## 响应式（**两层，别混用**）

> 完整口径见 [DESIGN.md](../../DESIGN.md) §10（双层模型）与 [docs/08](../../docs/08-全局响应式改造方案.md) V2。

- **页面外壳层 → 看视口**：侧栏（固定 ↔ Drawer）、顶栏精简、内容区边距、**页面级栅格的列数**。
  唯一来源 [`useResponsive()`](../../web/src/hooks/useResponsive.ts)；**禁止** `window.innerWidth` / `matchMedia`。
  四条硬性约定（Col 带断点、Table 声明 `scroll`、弹窗宽度可被全局兜底、≤md 侧栏走 Drawer）见 DESIGN.md §10。
  理由：外壳的容器**就是**视口，用视口判断语义正确。
- **组件内部 → 看容器**：卡片内列数、工具条折行、弹窗/抽屉里的表格与预览区、`.doc-preview`。
  用 `.cq`（`container-type: inline-size`）+ `@container` 表达；规则集中在 `web/src/styles/containers.css`。
  ⚠️ 组件**不知道**自己会被放到多宽的地方，"视口宽不宽"推不出"我这里挤不挤"——902px 弹窗里的表格
  在 1280 视口下会被当成"宽屏"渲染而破版，这正是两层分开的原因。
- **CSS 表达不了的才用 `useContainerWidth()`**（`web/src/hooks/useContainerWidth.ts`，`ResizeObserver`）：
  传给 AntD 的 JS prop（`Descriptions column`、`Table size`）、条件渲染、按容器宽度算的值。
  能用 `@container` 表达的别退化成 JS 判断。
  ⚠️ **它返回的是「回调 ref」（`(node) => void`），不是 `useRef` 对象，别改回去**：被测元素常是
  **条件渲染**的（`TaskViewModal` 的正文要等详情接口回来才渲染），而 `useRef` + `useEffect([])`
  会在挂载时读到 `null`、之后**永远不再挂观察器** —— 容器明明变窄了、派生档位却一直停在「宽」，
  **静默失效且测试不会红**。（2026-10-15 真渲染验收时正是这么踩到的：容器压到 600px 仍渲染 2 列。）
- `.cq` 的挂载条件：只能挂在**宽度由外部决定**的元素上（块级 / 百分比宽 / 栅格列）——
  `container-type: inline-size` 带 `contain: inline-size`，挂在靠内容撑宽的元素上**宽度会塌**；
  也别挂在含 `position: fixed; inset: 0` 全屏层的组件根上（containment 会让该 fixed 元素以它作包含块，
  `RichTextEditor` 全屏即为此例，故它只用 `useContainerWidth()`、不挂 `.cq`）。
  CQ 也**只能查祖先**，标记要挂在"外层包裹"上。
- **写法规则**：宽容器形态 = 基线样式（写在 `index.css`），窄容器覆盖一律写进 `containers.css` 的
  `@container` → 不支持 CQ 的旧内核自动回落到基线，属渐进增强（不写 `@supports`、不加 polyfill）。
- ⚠️ `@container` 的条件**不支持 `var()`**（实测整条规则被丢弃），只能写字面值；字面值必须等于
  `utils/containerSize.ts` 的 `CONTAINER_BREAKPOINTS`。这些（连同"视口值只许外壳用"）由
  `server/test/containerQuery.spec.mts` 锁死——**改断点要三处同步**（`containerSize.ts` ↔ `index.css` 的
  `--cq-*` ↔ `containers.css`）。

## 列表页列显隐（两条路别混用）

- ① 通用列表页 `ModuleListPage.columnConfigKey`：偏好存 **localStorage**，纯逻辑在 `utils/listColumns.ts`；
- ② 合同台账 `Ledger` 的 `ledger.columns.config`：**服务端共享**配置，页面列也由后端返回。
- 给台账页再传 `columnConfigKey` 会出现两套列设置打架；列显隐**不落 `sys_param`**（那是全局配置且需
  `system:config` 权限，普通用户存不了）。
