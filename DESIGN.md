# DESIGN.md · 视觉与交互规则

> **设计语言来源**：项目外部设计文档《Claude.com 设计系统分析》（奶油底 + 珊瑚主色 + 衬线标题 +
> 深墨面 + hairline 分层）。本文件是它在**企业数据后台**语境下的落地规范 —— **以本文档为准**。
> 动手前先读本文；所有 token 的 JS 事实源是 [web/src/theme.ts](web/src/theme.ts)，
> CSS 镜像在 [web/src/index.css](web/src/index.css) 的 `--cms-*`。

## 0. 移植了什么、不搬什么（取舍）

| ✅ 移植（设计语言层） | ❌ 不搬（营销页专属件） |
|---|---|
| 色板与表面层级：奶油 canvas / 珊瑚 primary / 暖中性灰阶 / 深墨面 / hairline | hero band、pricing tier、connector tile、footer、CTA 大色块 |
| 字体声音分裂：**衬线标题 400 + 负字距** / humanist sans 正文 | 摄影与插画规范、代码窗产品截图卡 |
| 圆角阶梯（4/6/8/12/16/pill）、4px 基数的间距尺度、pill 标签 | 96px 段间距、64px 展示级标题（后台要的是信息密度） |
| "color-block first, shadow rare"：靠色块与 hairline 分层，阴影极少 | "不写 hover 态"（保留 AntD 交互模型）、首页级整段节奏 |
| 响应式 <768 折叠（与本项目既有 md 断点天然对齐） | — |

> **不搬 Anthropic 的商标**：外部文档里的 radial-spike 标记与 "Claude" 字样属他人品牌资产，
> **不进入本产品**（借视觉语言，不借商标）。产品字标用中文字名（衬线）。

## 1. 主题（唯一入口）

出处：[web/src/App.tsx](web/src/App.tsx) → [web/src/theme.ts](web/src/theme.ts)

```tsx
<ConfigProvider locale={zhCN} theme={antdTheme}>   {/* antdTheme 全量来自 theme.ts */}
```

| Token | 值 | 说明 |
|---|---|---|
| `colorPrimary` | `#cc785c`（珊瑚） | 主按钮、选中态、链接、图表主系列 |
| `colorLink` | `#a9583e`（珊瑚深档） | **小字链接用深一档**：珊瑚配奶油底小字对比度不足（见 §9） |
| `colorInfo` | `#5db8a6`（青） | **信息 / 进行中**（取代原来"蓝 = 进行中"） |
| `colorSuccess` / `colorWarning` / `colorError` | `#5db872` / `#d4a017` / `#c64545` | 语义色 |
| `colorBgLayout` / `colorBgContainer` / `colorBgElevated` | `#faf9f5`（canvas） | 页面底、卡片、浮层统一奶油底 |
| `colorBorder` / `colorBorderSecondary` | `#e6dfd8` / `#ebe6df` | hairline 分层 |
| `borderRadius` / `LG` / `SM` | `8` / `12` / `6` | 控件 8、内容卡 12 |
| `fontFamily` | Inter + 中文黑体回退 | 见 §2 |
| `controlHeight` | `40` | 按钮/输入框高度（与外部文档的 40px 一致） |
| `boxShadow` / `boxShadowTertiary` | `none` | "shadow rare"：浮层只留极浅一档 |

语言固定 `zhCN`；`<AntdApp>` 提供 message/modal 上下文；最外层 `ErrorBoundary` 兜底。

## 2. 字体

**声音分裂**：衬线标题（400 字重 + 负字距）× humanist sans 正文。这是整套视觉最容易被"改回默认"的特征。

- **衬线** `'Noto Serif SC', 'Songti SC', 'SimSun', Georgia, serif` —— 自托管**思源宋体 400**
  （外部文档里 Copernicus 的开放替代；中文全覆盖，按 unicode-range 分片，浏览器只加载命中的切片）。
- **正文** `Inter, -apple-system, …, 'PingFang SC', 'Microsoft YaHei', sans-serif`
  —— 自托管 **Inter**（latin/latin-ext 子集），中文回退系统 humanist 黑体。
- **字体文件**：`web/public/fonts/`（`noto-serif-sc/` 101 片 ≈ 3.0MB、`inter/` 6 片 ≈ 391KB），
  由 `web/public/fonts/fonts.css` 声明，`web/index.html` 以 `<link>` 引入。
  **重新生成**：从 Google Fonts 取 `css2?family=Noto+Serif+SC:wght@400` 与 `family=Inter:wght@400;500;600`
  （带浏览器 UA 才返回 woff2 分片），把 `url(...)` 改写为 `/fonts/...` 本地路径即可。

**衬线的使用范围（有意收窄）**：页面/区块/卡片标题、弹窗标题、KPI 数字、侧栏与登录页字标。
**表格数据、合同名、用户输入内容一律不用衬线** —— 数字对齐与生僻字都不适合衬线，
且子集化的字体在用户数据上可能出现缺字。

| 场景 | 类名 / 选择器 | 规格 |
|---|---|---|
| 页面标题 | `.cms-serif-title.cms-title-page` | 24px / 1.25 / -0.4px |
| 区块标题 | `.cms-title-section` | 18px / 1.3 / -0.3px |
| 卡片标题 | `.ant-card-head-title`（全局） | 16px / -0.2px |
| 弹窗标题 | `.ant-modal-title`（全局） | 18px / -0.3px |
| KPI 数字 | `.ant-statistic-content`（全局） | 30px / 1.15 / -0.6px |
| 说明/次要文字 | `.cms-hint` | 12px + `--cms-muted-soft` |

正文 14px（AntD `fontSize`）；表格内数字沿用正文尺寸与 sans。

## 3. 颜色

### 3.1 色板（`theme.palette`，与 index.css 的 `--cms-*` 一一对应）

| 用途 | Token | 值 |
|---|---|---|
| 主色 / 按下 / 禁用 | `primary` / `primaryActive` / `primaryDisabled` | `#cc785c` / `#a9583e` / `#e6dfd8` |
| 页面底（暖奶油） | `canvas` | `#faf9f5` |
| 浅带 / 内容卡 / 强奶油 | `surfaceSoft` / `surfaceCard` / `surfaceCreamStrong` | `#f5f0e8` / `#efe9de` / `#e8e0d2` |
| 深墨面（侧栏+顶栏） | `surfaceDark` / `surfaceDarkElevated` / `surfaceDarkSoft` | `#181715` / `#252320` / `#1f1e1b` |
| 分隔线 | `hairline` / `hairlineSoft` | `#e6dfd8` / `#ebe6df` |
| 文字阶梯 | `ink` / `bodyStrong` / `body` / `muted` / `mutedSoft` | `#141413` / `#252523` / `#3d3d3a` / `#6c6a64` / `#8e8b82` |
| 深色面上的文字 | `onPrimary` / `onDark` / `onDarkSoft` | `#ffffff` / `#faf9f5` / `#a09d96` |
| 语义 | `success` / `warning` / `error` / `accentTeal` / `accentAmber` | `#5db872` / `#d4a017` / `#c64545` / `#5db8a6` / `#e8a55a` |
| 文档纸张（**不随主题**） | `paper` / `paperHead` | `#ffffff` / `#f2f2f2` |

`paper` 只用于合同正文/条款/委托书的「所见即所得」预览区——预览的是要打印导出的纸，
屏幕主题是奶油或纯白都不该改变它。

### 3.2 状态色（**语义名不动，渲染层映射**）

字典 `dict_item.color` 与 `constants/procurementWorkflow.ts` 的 `TASK_STATUS_COLORS` 里存的是
`blue/green/orange/purple/gold/cyan/default` 这类 **AntD 预置色名**，且是**前后端镜像常量**。
换视觉**不改这些名字**（改了会连带改字典数据与 `frontendChainParity` 等漂移锁），
而是在渲染层做映射 —— `theme.TONES` + `theme.PRESET_TONE_MAP`，
并由 [index.css](web/src/index.css) 的 `.ant-tag.ant-tag-<name>` 覆盖生效：

| 预置名 | 语义色 | 底色 / 字色 |
|---|---|---|
| `default` | neutral | `#f5f0e8` / `#3d3d3a` |
| `blue` `cyan` `processing` | teal（信息/进行中） | `#e7f4f1` / `#2c6f61` |
| `orange` `gold` `volcano` `warning` | amber（待处理/编辑中） | `#fbf1e0` / `#7d5a0e` |
| `green` `lime` `success` | success | `#e8f4ea` / `#2c6b41` |
| `red` `magenta` `error` | error | `#fbeae9` / `#9c3232` |
| `purple` `geekblue` | coral（审批/特殊） | `#f9ece7` / `#a9583e` |

语义约定：**绿=完成/成功 · 青=进行中/信息 · 琥珀=待处理/编辑中 · 珊瑚=审批/品牌 · 红=错误/逾期**。
覆盖规则写成 `.ant-tag.ant-tag-x`（特异度 0,2,0）——AntD 预置色样式的特异度是 (0,1,0)
且运行时注入更晚，不提升特异度压不住（实测踩过）。

### 3.3 图表

`theme.chartPalette` = 珊瑚 `#cc785c` → 青 `#5db8a6` → 琥珀 `#e8a55a` → 绿 `#5db872` → 深墨 `#181715` → 红 `#c64545`。
ECharts 5（`echarts-for-react`）；饼图统一 `radius: ['40%','70%']`。系列配色一律取 `chartPalette`，别再写死色值。

## 4. 圆角与间距

| 场景 | 圆角 | 出处 |
|---|---|---|
| 控件（Button/Input/Select/编辑器） | `8px`（`rounded.md`） | 全局 token |
| 页面卡片、统计卡、内容卡 | `12px`（`rounded.lg`） | `.page-card`、`Card` token |
| 侧栏菜单项、筛选块 | `6px`（`rounded.sm`） | Menu `itemBorderRadius`、`Sider/index.less` |
| 小色块、代码块 | `4px`（`rounded.xs`） | 局部内联（取 `--cms-radius-sm` 的近邻值） |
| 标签 / 徽标 | `9999px`（pill） | `Tag.borderRadiusSM` |

| 间距 | 规格 | 出处 |
|---|---|---|
| 基数 | **4px** | `theme.space` |
| 页面卡片内边距 | 桌面 `20` / ≤md `12` / ≤575 `8` | `.page-card` + index.css 媒体查询 |
| 内容区边距 | `16`（窄屏 `8`） | `BasicLayout` |
| 卡片/区块之间 | `16` | `Row gutter={[16,16]}` |
| 文档预览区 | `24`（窄屏 `12`） | `.doc-preview` |

> **后台密度取舍**：外部文档的 96px 段间距、32px 卡片内边距是营销页节奏，**不搬**；
> 后台在同一 4px 尺度上取紧凑端（16–24），表格反而要密（单元格 8/12 内边距），一屏多看几行。

## 5. 表面与层次（"color-block first, shadow rare"）

| 层 | 用法 |
|---|---|
| `canvas` `#faf9f5` | 页面底 + 卡片底（靠 `hairline` 而不是阴影分层） |
| `surfaceCard` `#efe9de` | 表格表头、选中项底（`Segmented` / 列表选中） |
| `surfaceSoft` `#f5f0e8` | 表格行 hover、`pre` 块、浅带 |
| `surfaceDark` `#181715` | **侧栏 + 顶栏**（骨架的深墨面） |
| `paper` `#ffffff` | 合同/条款预览纸张（唯一允许纯白的地方） |

阴影：默认 `none`，浮层仅 `0 1px 3px rgba(20,20,19,.08)`；抽屉保留方向性阴影（功能性）。

## 6. 组件样式约定

- **输入控件**：一律 AntD；下拉选项一律 `DictSelect`（`showSearch`、`minWidth:160`）；
  状态/标签一律 `DictTag`（走 §3.2 的语义映射）；纯文本 `DictText`。
- **按钮**：主按钮珊瑚底白字、高 40、圆角 8；次级奶油底 + hairline；文字链用 `colorLink`（珊瑚深档）。
- **表格**：表头 `surfaceCard` + `--cms-ink` 文字、行 hover `surfaceSoft`、行分隔 `hairline`；
  单元格内边距 `8/12`；`size` 按断点（≤md `small`）；**必须声明 `scroll={{ x }}`**；
  `≤md` 冻结关键列（采购编号）、操作列 `fixed: 'right'`。
- **卡片**：`canvas` 底 + `1px hairline` + 12 圆角、**无阴影**；标题衬线（§2）。
- **弹窗**：`canvas` 底、圆角 12、遮罩 `rgba(20,20,19,.45)`。
  `centered` **不强制全站**：轻量确认类弹窗加 `centered`；**高编辑弹窗保持顶部对齐**
  （成交报告/合同起草等超高弹窗垂直居中会被裁）。宽度一律由 index.css 的
  `max-width: calc(100vw - 16px)` 兜底。采购模块预览统一 `PreviewPublishModal`。
- **表单**：栅格布局（`Col` 一律写断点，见 §10）；筛选区每行 4 列（窄屏 2 列）；必填标 `*`。
- **编辑器聚焦态**：边框 `hairline` → 聚焦珊瑚 + `0 0 0 3px rgba(204,120,92,.15)` 外环。
- **未替换占位符高亮**：背景 `--cms-tone-amber-bg`、虚线底 `--cms-accent-amber`、字色 `--cms-tone-amber-fg`
  （[utils/docExport.ts](web/src/utils/docExport.ts)）——刻意显眼，提示模板变量漏填。

## 7. Word 导出排版（"所见即所得"）

出处：[web/src/utils/docExport.ts](web/src/utils/docExport.ts) `WORD_TPL`

- 纸张 A4，页边距 `2.54cm 2cm`；正文 `宋体/SimSun` 12pt、`line-height:1.8`、黑色。
- 标题 `h1` 18pt 居中（黑体）、`h2` 14pt（黑体）——**导出物不跟随屏幕的衬线/奶油体系**：
  打印与合同归档要的是标准公文观感，且 Word 不认 CSS 变量，故此处保留**字面色值**
  （`themeTokens.spec` 白名单里已注明）。
- 表格 `border-collapse: collapse; width:100%`，单元格 `1px solid #000; padding:6pt`；表头底 `paperHead`。
- 采购文档统一管线：`utils/procurementExport.ts` `buildProcurementDoc`（模板优先 → 变量替换 → 图片内联）。

## 8. 登录页

[web/src/pages/Login.tsx](web/src/pages/Login.tsx)：**奶油底**（不是渐变）、无阴影卡片 + hairline、
衬线中文标题 + 字距 1.5px 的英文副标、珊瑚主按钮。

## 9. Do / Don't

**Do**
- 改视觉**只改 `theme.ts`（JS 侧）与 `index.css` 的 `--cms-*`（CSS 侧）**——这两处是 token 层。
- 标题用衬线类名（§2）、标签走 `DictTag`/语义色映射、图表走 `chartPalette`。
- 新页面复用 `.page-card` 或 `ModuleListPage` 骨架；新列表优先 `useTable` + `ModuleListPage`。
- **响应式按 §10 四条硬性约定执行**。
- 小字链接/强调文字用 `--cms-primary-active`（珊瑚深档）；正文走 ink/body 灰阶。

**Don't**
- **不在组件里写死 `#hex` / `rgb()`**：由 `server/test/themeTokens.spec.mts` 锁定，白名单只有
  `theme.ts`、`index.css`、`Sider/index.less`、`RichTextEditor.tsx`（编辑器调色板是**功能**）、
  `docExport.ts`（Word 内联样式）。
- 不引入第二套 UI 库（MUI/Tailwind）、不新增第三个样式文件。
- 不把营销页组件搬进后台（hero/pricing/connector/footer），不使用 Anthropic 的商标与字标。
- 不硬编码状态中文/颜色：状态展示取自字典或 `constants/procurementWorkflow.ts`。
- 不用纯白做页面底（`paper` 只给文档预览）；不给卡片加重阴影。
- 不在组件里用 `window.innerWidth` / `matchMedia` 自行判断断点（见 §10）。
- 不为移动端给大宽表（36 列台账等）做卡片化——明确取舍，见 §10。

## 10. 响应式（断点与降级规则）

> 规范制定依据：[docs/08](docs/08-全局响应式改造方案.md)。**验收目标：≥768 平板完全可用；≥375 手机可读可操作。**

**断点唯一来源**

- JS 侧一律用 [`useResponsive()`](web/src/hooks/useResponsive.ts)（封装 AntD `Grid.useBreakpoint`），导出
  `{ isMobile(<768), isTablet, isDesktop(≥992), screens }`。
- **禁止**在组件内使用 `window.innerWidth` / `matchMedia`——多个断点来源会导致布局互相打架。
- 纯样式收敛（内边距、弹窗兜底）放在 [web/src/index.css](web/src/index.css) 的媒体查询里，
  阈值与 AntD 对齐（`max-width: 767.98px` / `575.98px`）。

**四条硬性约定**

1. **表单 `<Col>` 一律写断点**（`xs={24} md={n}`），**禁止固定 `span`**；筛选区用
   `xs={12} sm={12} md={8} lg={6}`（手机 2 列 / 平板 3 列 / 桌面 4 列）。
2. **表格必须声明 `scroll={{ x }}`**；`≤md` 时关键列（如采购编号）`fixed: 'left'`，
   操作列 `fixed: 'right'`；窄屏行高用 `size="small"`。
3. **弹窗宽度必须响应式**：宽度可在大屏取固定值，但必须能被全局 `max-width: calc(100vw - 16px)`
   兜住（该规则已在 `index.css` 全局生效，新增弹窗无需逐个改写）。
4. **侧栏 `≤md` 走 Drawer**：由 `AppSider` 内部按 `useResponsive()` 自动切换，选中菜单后自动关闭。

**明确不做（取舍）**

- **36 列合同台账等大宽表不卡片化**：列数过多，移动化收益低；保留横向滚动 + 冻结关键列。
- **复杂报表 / 导入导出配置 / 字典权限页不强行移动化**：PC 专属，仅保证不破版。
- 移动端不做原生 APP/H5 独立版本（如确有刚需页，另立专题）。
