# DESIGN.md · 视觉与交互规则

> 本项目前端 = **Ant Design 5 默认设计语言** + 少量自定义。新增页面/组件请遵循本文，
> 不要引入第二套 UI 库或自造色板。所有 token 均标注出处文件，改前先看那里。

## 1. 全局主题（唯一主题入口）

出处：[web/src/App.tsx](web/src/App.tsx)

```tsx
<ConfigProvider
  locale={zhCN}
  theme={{
    token: { colorPrimary: '#1677ff', borderRadius: 6 },
    components: { Table: { cellPaddingBlock: 10 } },
  }}
>
```

| Token | 值 | 说明 |
|---|---|---|
| `colorPrimary` | `#1677ff` | 主色（AntD v5 默认蓝）。链接、主按钮、选中态、图表主系列 |
| `borderRadius` | `6px` | 控件级圆角基准（按钮/输入框/选择器） |
| `Table.cellPaddingBlock` | `10px` | 表格单元格垂直内边距 |

- 语言固定 `zhCN`。
- `App` 外层套 antd 的 `<AntdApp>`（提供 message/modal 静态方法上下文），
  最外层由 `ErrorBoundary` 兜底（[web/src/main.tsx](web/src/main.tsx)）。

## 2. 圆角规范

| 场景 | 圆角 | 出处 |
|---|---|---|
| 控件（Button/Input/Select/编辑器容器） | `6px` | 全局 token |
| 页面级卡片、统计卡 | `8px` | `.page-card`/`.stat-card`（[index.css](web/src/index.css)）、`ModuleListPage`、`Finance` 等 |
| 侧边菜单项、搜索结果项 | `6px` | [Sider/index.less](web/src/components/Sider/index.less) |
| 色块、小标签 | `3px` | RichTextEditor 颜色面板 |
| 代码块 | `4px` | `System.tsx` 内 `<pre>` |

## 3. 颜色

### 3.1 语义色

| 用途 | 色值 | 出处 |
|---|---|---|
| 主色 / 选中 / 头像底 / 登录渐变起点 | `#1677ff` | 全局 token、`BasicLayout` 头像、`Login` |
| 成功 / 付款系列 | `#52c41a` | 图表、状态 |
| 警告 / 强调橙 | `#faad14` `#fa8c16` `#d48806` | 图表、占位符虚线、逾期 |
| 错误 / 金额强调 | `#ff4d4f` `#cf1322` `#d4380d` | 表单校验红、金额、深红强调 |
| 紫色（发票/合同编制中） | `#722ed1` | 图表、状态标签 |
| 次要文字 | `#8c8c8c`（**全站最高频**，38 处） | 说明/计数文字 |
| 三级文字 / 占位 / 禁用 | `#bfbfbf` `#999` `#888` | placeholder、disabled |
| 正文强调 | `#595959` | blockquote、次要正文 |
| 边框 / 分隔线 | `#f0f0f0`（浅）`#d9d9d9`（控件边）`#eee`（预览区） | 各处 |

### 3.2 状态色约定（业务语义）

- **采购任务状态**（[web/src/constants/procurementWorkflow.ts](web/src/constants/procurementWorkflow.ts) `TASK_STATUS_COLORS`）：
  `NOT_STARTED` default · `*_EDITING` orange（`LIST_EDITING`）/ blue（其余编制中） ·
  `CONTRACT_EDITING` purple · `CONTRACT_APPROVING` gold · `COMPLETED` green。
- **采购模块列表状态**（`ModuleListPage.moduleStatusOf`）：
  未填写 `default` · 编辑中 `orange` · 已完成 `blue`。
- **分包商状态**：编辑中 `orange` · 已完成 `green`。
- **合同签章状态**（合同查询）：`SIGNED` 已签章 `green`。
- 通用规则：**绿=完成/成功、蓝=进行中/信息、橙=待处理/编辑中、紫=审批/特殊、红=错误/逾期**。

### 3.3 图表配色

| 系列 | 色值 | 出处 |
|---|---|---|
| 结算 | `#1677ff` | Dashboard 折线、Reports |
| 付款 | `#52c41a` | Dashboard 柱、Reports |
| 发票类型 | `#722ed1` | Reports |
| 发票状态 | `#fa8c16` | Reports |
| 金额强调 | `#cf1322` | Dashboard |

饼图统一 `radius: ['40%', '70%']`（环形）。图表库为 **ECharts 5**（`echarts-for-react`）。

## 4. 字体与排版

- 字体族：不指定全局字体，沿用 AntD 默认（系统 UI 字体栈）；正文 14px。
- 富文本编辑器内置（[RichTextEditor.tsx](web/src/components/RichTextEditor.tsx)）：
  编辑区 `font-size:14px; line-height:1.8`；可选字体 宋体/仿宋/黑体/微软雅黑/楷体；
  中文字号映射（初号 42pt … 小五 9pt）；`h1` 18pt 居中（黑体）、`h2` 14pt（黑体）；
  `blockquote` 左边框 `3px solid #d9d9d9`、字色 `#595959`；段落 `margin: 0 0 8px`。
- 常用字号：正文 `14`、次要/说明 `12`（**高频，37 处**）、辅助 `13`、图标 `16`/`22`。

## 5. 间距与布局

| 元素 | 规格 | 出处 |
|---|---|---|
| 侧边栏展开 / 折叠宽 | `220px` / `80px`（窄屏为抽屉，同为 `220px`） | [Sider/index.less](web/src/components/Sider/index.less) |
| 侧边栏背景 | `#001529`（AntD 深色），`position: sticky; height: 100vh`（抽屉内 `static`） | 同上 |
| Logo 区高 | `56px`，底部 `1px solid rgba(255,255,255,.08)` | 同上 |
| 顶栏 Header | `padding: 0 16px`（窄屏 `0 8px`），底边框 `1px solid #f0f0f0` | [BasicLayout.tsx](web/src/layouts/BasicLayout.tsx) |
| 内容区 Content | `margin: 16`（窄屏 `8`） | 同上 |
| 页面卡片内边距 | `16px`（≤767 `8px`，≤575 `6px`） | `index.css` `.page-card`、`ModuleListPage` |
| 筛选区每行字段数 | 桌面 `4` / 手机 `2`（超出可折叠）；`Col` 为 `xs=12 sm=12 md=8 lg=6` | `ModuleListPage` |
| 预览/文档区 | `padding: 24`（窄屏 `12`）、`border: 1px solid #eee`、`max-height: 52vh`（弹窗内 58vh） | `.doc-preview`、`PreviewPublishModal` |
| 表格 | `size="middle"`（窄屏 `small`）、`scroll={{ x: 'max-content' }}`，分页 `[10,20,50,100]` | `ModuleListPage` |
| 响应式断点 | AntD 默认：`xs<576 · sm≥576 · md≥768 · lg≥992 · xl≥1200`（见 §10） | `hooks/useResponsive.ts`、`index.css` |

## 6. 组件样式约定

- **输入控件**：一律用 AntD；下拉选项一律 `DictSelect`（带 `showSearch`、`minWidth:160`）；
  状态/标签一律 `DictTag`（按字典 `color` 上色）；纯文本用 `DictText`。
- **弹窗**：全站统一**居中**（`centered`）；采购模块预览统一用 `PreviewPublishModal`（宽 1000）。
- **表单**：栅格布局（`Col` 一律写断点，见 §10）；筛选区每行 4 列（窄屏 2 列）；必填标 `*`。
- **编辑器聚焦态**：边框 `#d9d9d9` → 聚焦 `#1677ff`；禁用背景 `#f5f5f5`。
- **未替换占位符高亮**：背景 `#fff1b8`、虚线底 `#d48806`、字色 `#ad6800`
  （[utils/docExport.ts](web/src/utils/docExport.ts) `highlightPlaceholders`）——刻意显眼，提示模板变量漏填。

## 7. Word 导出排版（"所见即所得"）

出处：[web/src/utils/docExport.ts](web/src/utils/docExport.ts) `WORD_TPL`

- 纸张 A4，页边距 `2.54cm 2cm`。
- 正文：`宋体/SimSun`，`12pt`，`line-height:1.8`，黑色。
- 标题：`h1` 18pt 居中（黑体）、`h2` 14pt（黑体）。
- 表格：`border-collapse: collapse; width:100%`，单元格 `border:1px solid #000; padding:6pt`。
- 表格 HTML 表头背景 `#f2f2f2`（见 `SupplementDraft.buildTableHtml` 等）。
- 采购文档统一管线：`utils/procurementExport.ts` `buildProcurementDoc`（**模板优先 → 变量替换 → 图片内联**）。

## 8. 登录页

[web/src/pages/Login.tsx](web/src/pages/Login.tsx)：背景 `linear-gradient(135deg, #1677ff 0%, #69b1ff 100%)`；
卡片宽 `380`、`box-shadow: 0 8px 24px rgba(0,0,0,.12)`。

## 9. Do / Don't

**Do**
- 新页面复用 `.page-card` 或 `ModuleListPage` 骨架；新列表优先用 `useTable` + `ModuleListPage`。
- **响应式按 §10 四条硬性约定执行**：Col 带断点、Table 声明 `scroll={{x}}`、弹窗宽度可被兜底、
  断点判断一律走 `useResponsive()`。
- 颜色优先取 AntD token（`theme.useToken()`）或本文档表中的语义色，保持全站一致。
- 下拉/标签一律走字典组件，不要硬编码选项与颜色。

**Don't**
- 不引入第二套 UI 库（MUI/Tailwind/自研色板）。
- 不新增 `.css/.less` 之外的主题机制——全站目前仅两个样式文件
  （[web/src/index.css](web/src/index.css)、[Sider/index.less](web/src/components/Sider/index.less)），
  其余样式以内联 `style` 为主，保持现状即可。
- 不硬编码状态中文/颜色：状态展示取自字典或 `constants/procurementWorkflow.ts`。
- 不在组件里用 `window.innerWidth` / `matchMedia` 自行判断断点（见 §10）。
- 不为移动端给大宽表（36 列台账等）做卡片化——明确取舍，见 §10。

## 10. 响应式（断点与降级规则）

> 规范制定依据：[docs/08](docs/08-全局响应式改造方案.md)。**验收目标：≥768 平板完全可用；≥375 手机可读可操作。**

**断点唯一来源**

- JS 侧一律用 [`useResponsive()`](web/src/hooks/useResponsive.ts)（封装 AntD `Grid.useBreakpoint`），导出
  `{ isMobile(<768), isTablet, isDesktop(≥992), screens }`。
- **禁止**在组件内使用 `window.innerWidth` / `matchMedia`——多个断点来源会导致布局互相打架，
  这正是改造前「0 处断点监听、布局不响应」的根因。
- 纯样式收敛（内边距、弹窗兜底）放在 [web/src/index.css](web/src/index.css) 的媒体查询里，
  阈值与 AntD 对齐（`max-width: 767.98px` / `575.98px`）。

**四条硬性约定**

1. **表单 `<Col>` 一律写断点**（`xs={24} md={n}`），**禁止固定 `span`**；筛选区用
   `xs={12} sm={12} md={8} lg={6}`（手机 2 列 / 平板 3 列 / 桌面 4 列）。
2. **表格必须声明 `scroll={{ x }}`**；`≤md` 时关键列（如采购编号）`fixed: 'left'`，
   操作列 `fixed: 'right'`；窄屏行高用 `size="small"`。
3. **弹窗宽度必须响应式**：宽度可在大屏取固定值，但必须能被全局 `max-width: calc(100vw - 16px)`
   兜住（该规则已在 `index.css` 全局生效，新增弹窗无需逐个改写）。
4. **侧栏 `≤md` 走 Drawer**：由 `AppSider` 内部按 `useResponsive()` 自动切换，选中菜单后自动关闭；
   调用方只管 `collapsed` 状态。

**明确不做（取舍）**

- **36 列合同台账等大宽表不卡片化**：列数过多，移动化收益低；保留横向滚动 + 冻结关键列。
- **复杂报表 / 导入导出配置 / 字典权限页不强行移动化**：PC 专属，仅保证不破版。
- 移动端不做原生 APP/H5 独立版本（如确有刚需页，另立专题）。
