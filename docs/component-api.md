# 组件与接口参考（Component API）

> 复用前先查这里：**前端组件 props**、**hooks/工具函数**、**API 模块**、**后端通用服务**。
> 视觉规范见 [../DESIGN.md](../DESIGN.md)；全量 REST 接口见 [03-API接口清单.md](03-API接口清单.md)。

---

## 一、前端 · 通用组件（`web/src/components/`）

### DictSelect / DictTag / DictText
`web/src/components/DictSelect.tsx` — 字典驱动的选择/展示（**所有下拉与标签的唯一来源**）。

| 组件 | Props |
|---|---|
| `DictSelect` | `typeCode: string`（字典类型编码）· `value` · `onChange` · `mode`（`multiple` 等）· `allowClear?`（默认 true）· `disabled?` · `placeholder?`（默认「请选择」）· `extValue?`（按 `extField1` 联动过滤）· `style?` |
| `DictTag` | 按字典项的 `color` 渲染 Tag；无值显示 `-` |
| `DictText` | 渲染字典项纯文本 label |

内部用 `useDictStore.ensure(typeCode)` 自动拉取并缓存；`showSearch` + `optionFilterProp="label"`。

### ErrorBoundary
`web/src/components/ErrorBoundary.tsx` — 类组件，`getDerivedStateFromError` + `componentDidCatch`。
出错渲染 `Result status="error"` + 「重试」/「刷新页面」。挂在 `main.tsx` 最外层。

### ImportButton
`web/src/components/ImportButton.tsx` — 通用「导入」二级菜单按钮，三阶段 UI（下载模板/上传 → 进度 → 结果汇总）。

| Prop | 类型 | 说明 |
|---|---|---|
| `moduleName` | `string` | 导入模块名（提示/文件名用） |
| `templateUrl` | `string \| () => string` | 下载模板地址 |
| `uploadUrl` | `string \| (file) => string` | 上传地址 |
| `onUpload` | `(file) => Promise` | 自定义上传（优先于 `uploadUrl`） |
| `disabled?` | `boolean` | |
| `onDone?` | `() => void` | 完成回调（刷新列表） |
| `extraHint?` | `ReactNode` | 附加提示 |

> 超过 1000 行自动轮询 `/import-tasks/:id`（每 1500ms）；单次上限 5000 行；「全成功或全失败」。
> 下载走 `utils/download.withToken()`。

### PreviewPublishModal
`web/src/components/PreviewPublishModal.tsx` — 采购模块统一「预览 / 发布前确认」弹窗（宽 1000）。

| Prop | 说明 |
|---|---|
| `open` `moduleType` `taskId` `templateId?` | 基本信息 |
| `docHtml` `values` | 文档 HTML 与变量值（内部经 `buildProcurementDoc` 套模板+替换变量） |
| `mode` | `'publish' \| 'preview'` |
| `title` `filename` `projectAbbr?` `content?` | 标题/导出文件名等 |
| `publishing?` `confirmTitle?` `confirmDescription?` `tipMessage?` | 发布确认样式 |
| `onPublish` `onClose` `onExport` | 回调 |

预览区 `maxHeight:58vh`、`border:1px solid #eee`、`padding:24`；未替换占位符高亮。

### ProjectSwitch
`web/src/components/ProjectSwitch.tsx` — 当前项目下拉（宽 220），切换后 `setCurrentProject` + `window.location.reload()`；无项目返回 null。

### RichTextEditor
`web/src/components/RichTextEditor.tsx` — 零依赖 contentEditable 富文本编辑器（合同/采购模板用）。

| Prop | 说明 |
|---|---|
| `value` `onChange` | 受控内容 |
| `variables?` | 可插入变量列表 |
| `variableGroups?` | 变量分组（分类 + 搜索） |
| `placeholder?` `minHeight?`（默认 320）`disabled?` | |

工具栏：字体/中文字号/加粗斜体下划线删除线/字体色背景色/对齐(含两端)/列表/预置块样式/插入表格·图片·分页符/撤销重做/清除格式/查找替换/插入变量/全屏。占位符用 `{{变量名}}`。

### Uploader
`web/src/components/Uploader.tsx` — 附件上传。Props：`value: UploadFile[]` · `onChange` · `max?`（默认 5）。

### Sider 套件（`web/src/components/Sider/`）

| 文件 | 职责 |
|---|---|
| `index.tsx`（`AppSider`） | 侧边栏主组件。Props：`collapsed?`（受控）· `onCollapsedChange?` · `defaultCollapsed?` · `title?`（默认「供应链管理系统」）· `shortTitle?`（默认「SCM」）。宽 220/折叠 80，深色主题，折叠状态持久化。导出 `BreadcrumbNav`、`renderIcon`、`MENU_CONFIG` |
| `menuConfig.ts` | 本地兜底菜单 `MENU_CONFIG`（接口失败时用）；叶子带 `permission` 码 |
| `RecursiveMenu.tsx` | 递归渲染菜单项；Props：`items` `selectedKeys` `openKeys` `onOpenChange` `onNavigate` |
| `MenuLoader.tsx` | render-prop 加载器；Props：`children: (menu) => ReactNode` · `onMenu?`。loading→Spin，空→Empty+重试，兜底→warning Alert |
| `BreadcrumbNav.tsx` | 面包屑；Props：`homeLabel?` `homePath?`（默认「工作台」/`dashboard`） |
| `Logo.tsx` | 展开显示全称、折叠显示缩写 |
| `SearchInput.tsx` | 菜单搜索输入 + 结果平铺（label + 链路） |
| `hooks/useMenuData.ts` | 菜单数据流：`sessionStorage` 缓存(TTL 5min) → `GET /api/menu` → 按权限过滤；失败兜底本地菜单；提供 `reload` |
| `hooks/useMenuSearch.ts` | 防抖 300ms 递归搜索，返回 `keyword/setKeyword/results/active/clear` |
| `hooks/useBreadcrumb.ts` | 由当前路由生成面包屑链路（首项固定「工作台」） |
| `utils/menuHelper.ts` | `isLeaf` `flattenMenu` `searchMenu` `findMenuChain` `getOpenKeysByPath` `getSelectedKeyByPath` `filterByPermission` |
| `utils/iconHelper.tsx` | 图标名 → 组件（`ICON_MAP`），未知兜底 `FileOutlined` |
| `utils/storage.ts` | 缓存键与读写（前缀 `scm_sider_`，TTL 5min；存储不可用静默降级） |
| `types/index.ts` | 全部类型定义 |

### 合同组件（`web/src/components/contract/`）

| 组件 | Props | 说明 |
|---|---|---|
| `ContractItemTab.tsx` | `contractId` `contractTaxPct` `onDirty?` | 起草 Tab2 合同清单；单位取字典 `measurement_unit`；含税单价/合价自动算 |
| `MaterialPoolTab.tsx` | `contractId` `onChanged?` | 起草 Tab1 物料池 |
| `MaterialPickerModal.tsx` | `open` `excludeIds?` `onCancel` `onOk(ids)` | 物料选择弹窗（检索基础库，支持手动新增） |
| `SupplementDraft.tsx` | — | 补充协议起草（涨价/降价/增量/增项/其他），生成 `{{补充协议表}}` HTML |

### 采购组件（`web/src/components/procurement/`）

| 组件 | Props（要点） | 说明 |
|---|---|---|
| `ModuleListPage.tsx` | `moduleKey` `mode('module'\|'generic')` `fetcher` `baseParams?` `extraFilters?` `extraColumns?` `toolbarLeft?` `actionBeforeSearch?` `refreshKey?` `onView/onEdit/rowEditable/onDelete/rowDeletable/rowMenuItems` `showOpColumn?` `emptyText?` `columnConfigKey?` `columnConfigLockedKeys?` | 采购六模块通用标准列表页；导出 `moduleStatusOf`、`useModuleDelete`。**列设置**：传 `columnConfigKey` 即启用（module 模式自动取 `procurement.<moduleKey>`），偏好存 **localStorage**（每浏览器）；「操作」列与 module 模式的「采购编号」列不可隐藏 |
| `ModuleDetailCard.tsx` | `title` `taskNo` `content` `statusLabel` `statusColor` `publishedAt` `extraDescriptions` `docHtml` `docLoading` `actions` | 只读详情卡片；含 `useModuleDetailDoc(...)` |
| `TaskViewModal.tsx` | `task{id,taskNo,status,stage}` `open` `onClose` | 任务查看（基本信息 + 总清单 + 已生成文档导出） |
| `TotalListEditor.tsx` | 导出 `TotalListEditor`、`TotalListEditorContent`（`readOnly`/`embedded`）、`TotalListContentRef` | 总采购清单编辑器（15 列，物资必须选自基础库） |

---

## 二、前端 · hooks

| Hook | 签名 | 说明 |
|---|---|---|
| `useTable<T>` | `(fetcher, defaultParams?) → { loading, list, total, params, setParams, search(extra), reload, pagination }` | 通用列表查询（默认 `page/pageSize=20`）；内部去抖动与丢弃过期响应 |
| `useListColumns` | `({ configKey?, allKeys, lockedKeys? }) → { hiddenKeys, isHidden, toggle, reset, hiddenCount }` | 列表页**列显隐**偏好，按 `configKey` 存 localStorage（每浏览器，不落库）；纯逻辑在 `utils/listColumns.ts`（可单测）。与 `ledger.columns.config`（服务端共享配置）**语义不同**，勿混用 |

（Sider 的 `useMenuData/useMenuSearch/useBreadcrumb` 见上。）

## 三、前端 · 工具函数（`web/src/utils/`）

| 文件 | 导出（要点） | 说明 |
|---|---|---|
| `money.ts` | `amountToChineseCapital(input)` | 金额转中文大写（四舍五入到分；零金额「零元整」） |
| `download.ts` | `withToken(url)` | 给下载/上传 URL 追加 `?token=&projectId=`（`window.open` 无法带请求头） |
| `docExport.ts` | `WORD_TPL` `exportWord(html,filename)` `printHtml(html,title)` `highlightPlaceholders(html)` | Word HTML 模板 / 导出 `.doc` / 打印 / 占位符高亮 |
| `procurementExport.ts` | `buildProcurementDoc` `exportProcurementWord` `fetchModuleTemplate` `procurementExportFilename` `inlineImageUrls` | 采购统一导出管线：**模板优先 → 变量替换 → 图片内联** |
| `procurementTaskDocs.ts` | `TaskModuleType` `TASK_MODULE_LABELS` `buildTaskModuleDoc` `exportTaskModuleWord` | 任务级文档 |
| `procurementNotice.ts` / `procurementDocument.ts` / `procurementResultReport.ts` / `procurementPriceCompare.ts` / `preMeetingMinutes.ts` / `frameworkExplanation.ts` | `buildXxxDocHtml` `buildXxxVariableValues`（priceCompare/preMeetingMinutes 另含 `calcAmount/round2/deriveRow/rankByRound/defaultFinalPrice` 等） | 各采购模块「数据模型 + 派生计算 + 表格 HTML + 变量值 + 文档 HTML」 |
| `listColumns.ts` | `columnKeyOf` `listColumnsStorageKey` `readHiddenColumns` `writeHiddenColumns` `clearHiddenColumns` `nextHiddenColumns` `filterVisibleColumns` | 列表列显隐的**纯逻辑**（零依赖，`server/test/listColumns.spec.mts` 覆盖）：存「隐藏的列」使新增列默认可见；至少保留一列；受保护列不可隐藏 |

## 四、前端 · 常量与 API 模块

- `constants/procurementWorkflow.ts`：采购类型、状态、状态颜色、阶段链 `buildStageChain`（**后端 `constants/procurementFlow.ts` 的镜像**）。
- `constants/procurementVariables.ts`：采购变量体系（公共变量无前缀，模块专属用「模块名-变量名」；表格变量生成真实表格）。
- `api/http.ts`：axios 实例（`baseURL=VITE_API_BASE||'/api'`，timeout 30s）。
  请求拦截注入 `Authorization: Bearer <cms_token>` 与 `x-project-id`；
  响应拦截 `code===0` 时**直接返回 `data`**，否则 `message.error`（1401 清 token 跳登录）。
- `api/auth.ts`：`authApi`（login/profile/logout/changePassword）· `fileApi.upload`（返回 `{ url, key, fileName, size }`——**落库用相对键 `key`**，展示用 `url`，二者不要混用）· `systemApi`（用户/角色/权限/参数/日志）。
- `api/dict.ts`：`dictApi`（types/items CRUD、`options(typeCode,extValue)`、`optionsBatch`、toggle、sortItems、usage、refreshCache、exportUrl/importUrl）。
- `api/business.ts`：`projectApi`、`supplierApi`、`contractApi`、`templateApi`，并再导出 `modules.ts` 的各业务 api。
- `api/modules.ts`：`procurementApi`、`procurementTaskApi`、`dailyApi`、`materialApi`、`contractMaterialApi`、`settlementApi`、`paymentApi`、`invoiceApi`、`assetApi`、`ledgerApi`、`repaymentApi`、`financeApi`、`notificationApi`、`dashboardApi`、`receiptOrderApi`、`subcontractorApi`。
- `store/auth.ts`（`useAuthStore`）：`token/user/permissions/projects/currentProjectId/params` + `login/loadProfile/logout/setCurrentProject/hasPermission`。
- `store/dict.ts`（`useDictStore`）：`cache/nameMap` + `ensure/options/label/invalidate`。

---

## 五、后端 · 通用服务（`server/src/common/`）

| 服务 / 工具 | 接口（要点） |
|---|---|
| `ResponseInterceptor` | 全局包装 `{ code:0, data, message:'ok', timestamp }`；`x-raw-response:1` 跳过 |
| `AllExceptionsFilter` | 全局异常 → `{ code, data:null, message }`（500→1500 / 401→1401 / 403→1403 / 400→1001） |
| `OperationLogInterceptor` | 写操作留痕（`ROUTE_MAP`、变更前后快照、导入统计、密码脱敏、截断） |
| `ExcelService` | `export(columns, rows, sheetName)` · `parse(buffer, skipRowNumbers)` |
| `StyledExcelService` | `exportTable(...)` · `withWorkbook(...)`（列类型 text/center/money/qty/pct/int） |
| `ImportTemplateService` | 生成填写模板（列类型 text/int/number/money/qty/pct/date/select；`TEMPLATE_MAX_ROWS=5000`） |
| `ImportRunnerService` | 两阶段执行器；`RowError` · `ImportOutcome{total,created,updated,errors}` · `batchDup()` |
| `ImportTaskService` | 异步导入（阈值 1000）：`list` / `findOne`（进度轮询）；完成发站内信，失败行出错误报告 |
| `SysParamService` | `get(key, def)` · `set(key,value,remark)` · `getAll()` · `refresh()`（内存缓存） |
| `StorageService` | `save(buffer,{sub?,ext?,name?})` · `read` · `exists` · `remove` · `publicUrl(key)` · `absPath(key)` · `resolveDir(sub?)` · `allocateName(ext)` · `ensureRoot()`（**文件落盘唯一入口**；相对键形如 `signed/x.pdf`，对外 URL `/api/files/<键>`；越权路径 400） |
| `LogService` | `operation(...)` · `login(...)`（失败不阻断） |
| `pickFields(data, allowed, opts?)` | 白名单过滤（默认 warn，`strict` 抛 400） |
| `utils/money` | `amountToChineseCapital` · `round` / `round2` / `round4` |
| `utils/storage-keys` | `resolveUploadRoot` `defaultSubDir` `storageFileName` `normalizeStorageKey` `assertSafeStorageKey`(越权抛 `StorageKeyError`) `absPathOf` `publicUrlOf`（存储键的纯逻辑，`server/test/storageKeys.spec.mts` 覆盖） |
| `utils/helpers` | `num` `sum` `toDate` `monthKey` `yearOf` · `paginate`(上限 500) · `buildResult` · `ratio` · `fmtDate` · `assertImportRows` · `assertVersion`(409) |
| `utils/docx-patch` | `patchDocx(buffer, setup)` 注入页眉/页脚/页码 |

### 装饰器（`server/src/common/decorators/`）

| 装饰器 | 用途 |
|---|---|
| `@Public()` | 跳过 `JwtAuthGuard`（全项目仅 `POST /auth/login`） |
| `@RequirePermissions(...codes)` | 声明权限码，OR 语义；superAdmin 直通 |
| `@CurrentUser(field?)` | 取 `req.user`（`JwtUser`：userId/username/realName/isSuperAdmin/permissions） |
| `@ProjectId()` | 取项目上下文：`req.projectId → x-project-id → query → body`，缺失抛 400 |
| `@ClientIp()` | 取 ip / x-forwarded-for |

### 后端共享常量（`server/src/constants/`）

| 文件 | 导出（要点） |
|---|---|
| `procurementFlow.ts` | `TASK_TYPES` · `STAGE_KEYS` · `TASK_STATUS_LABELS` · `stageChain()` · `deriveContractType()` · `stageView()` · `contractStageState()` · `MODULE_TASK_TYPES` · `moduleStageBranches()` · `resolveContractUnits()` · `CONTRACT_TYPE_LABELS` |
| `workflowGuards.ts` | `CONTRACT_STATUS` · `assertContractRejectable()` · `SETTLEMENT_STATUS` · `assertSettlementRejectable()` · `assertResultReportRejectable()` |
