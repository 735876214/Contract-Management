# AI 经营数据助手：按需取数 → 报告 / 表格

> 基准：2026-11-12。业务已确认的形态：上传表格附件填报、一段自然语言生成报告；范围支持全部项目与多选项目；报告与表格都要；数据面覆盖所有业务模块；生成物落库并保留历史（仅本人可见，超管可看全部）；入口为独立菜单 `/ai/analytics`。
>
> 本文只回答：现状是什么、要做什么、怎么做、分几期、怎么验收。实现细节以代码与后续提交为准。

## 一、现状深查结论

### 1.1 现有 AI 模块的四条能力线

1. **模板智能填报**（`server/src/modules/ai/ai.service.ts`）：上传 .xlsx → `form-scan` 扫描槽位 → 模型仅在 `AI_FIELD_CATALOG`（44 个字段）内选字段 → 服务端 `FieldResolverService` 取值原位回填。prompt 里只有字段标签，没有业务值。
2. **文件登记**（`register.service.ts`）：合同文件解析 → 人工逐项核对 → 确认后走 `ContractService.create` 写库。写库前必须经人确认。
3. **汇报材料**（`report.service.ts`）：单项目 + 固定区间 + 3 种材料类型（月度/项目履约/领导摘要）；事实由程序聚合，模型只组织语言，产出后 `auditReport()` 逐数字对账。
4. **三个项目内预警 + 一个跨项目供应链全景**（`anomaly/`、`quote/`、`fulfillment/`、`analysis/`）：规则层纯函数 + 模型措辞 + 数字对账 + 未判定清单。

### 1.2 可直接复用的资产

| 资产 | 位置 | 价值 |
|---|---|---|
| 事实包 → Markdown → 对账 | `ai/report-facts.ts`（`factsToMarkdown` / `factNumbers` / `deltaOf` / `auditReport` / `stripNonData` / `scanNumbers`） | 报告管线的护栏，必须复用 |
| 跨项目事实层 | `ai/analysis/scm-facts.ts`（`buildScmFacts` / `scmFactsToMarkdown` / `scmFactNumbers` / `scmPctNumbers`） | 唯一跨项目先例：合同链、供应商集中度、逾期节点、整数分 |
| 字段目录 + 取值 | `ai/field-catalog.ts` + `ai/field-resolver.service.ts`（`resolve` / `projectStats`） | 填表的数据字典与取值入口 |
| 跨项目权限收口 | `ai/analysis/scm.service.ts`（`projectWhere.members`） | IDOR 防护范式 |
| 公文骨架 | `ai/report-templates.ts` + `ai/report-prompt.ts` | 节标题固定、prompt 铁律 |
| 导出 | `report.service.ts` `exportDocx` / `exportPdf`；`common/services/styled-excel.service.ts`（`exportTable` / `withWorkbook`） | Word/PDF 与 Excel 基础设施 |
| 口径纯函数 | `contract-chain.ts`、`amount-guard.ts`、`ledger-derived.ts`、`contract-fulfillment.ts`、`asset-flow.ts`、`labor-receiving.ts`、`milestone.ts`、`settlement-period.ts`、`paidPaymentWhere()`、`notDraft` | 所有指标的唯一口径来源 |
| 可注入服务 | `LedgerService`、`DashboardService`、`CostService`、`LaborReceivingService`、`MonthlyProfitLossService`、`AssetService` 均已 `exports` | 避免重写台账/成本聚合 |
| 前端展示 | `web/src/components/ReportMarkdown.tsx`、`aiApi`、`ScmAnalysisPanel` 的多项目选择 + 导出交互 | 报告预览与下载管线 |
| 配置/配额 | `ai-config.ts`、`ai-setting.service.ts`、`ai-quota.ts` | 用途级模型、失败退款、密钥只写不读 |

### 1.3 关键缺口

1. **无自然语言 → 取数意图层**：全仓无 NL 解析/工具调用/查询生成；报告的 `extra` 只进 prompt 改措辞，不影响取数。
2. **报告范围单一**：`report/generate` 绑定 `@ProjectId()`，只有单项目；跨项目只有供应链全景（固定指标、累计口径）。
3. **材料骨架固定**：3 种 `ReportKind` + 全景 4 节，无法按需求组合章节/指标。
4. **字段目录窄**：44 字段仅 project/contract/supplier/6 项项目统计；无期间发生额、无跨项目聚合、无台账/成本/采购/资产/日报。
5. **填表上下文单项目**：`ResolveContext` 只有 projectId/contractId/supplierId。
6. **只能填上传模板**：不能由数据直接生成 xlsx。
7. **无历史**：报告生成即返回；本轮新增落库 + 历史列表。

### 1.4 现有口径缺陷（业务 2026-11-12 确认随本期修复）

- `ReportService.windowNumbers` 与 `FieldResolverService.projectStats` 的发票合计**未排除** `CANCELLED` / `RED`；台账 `ledger.service.ts` 同样未排除（与 `scm-facts.ts` 口径不一致）。
- `ReportService.windowNumbers` 的区间新签金额 = Σ(`amount + changeAmount`)，备注补充协议时其自由填写的 `amount` 与 `changeAmount` 会**重复计入**。
- `windowNumbers` 的结算/日报用 `createdAt` 而非业务发生日。

## 二、设计总览

保持仓库既有哲学：**不新建 AI 基础设施，只新增「指标层 + 意图层 + 面板」；程序算数、模型说话、数字对账；业务数据只读，仅写 AI 留痕表**。

```text
前端 /ai/analytics
  ├─ 生成页签：范围/期间/数据集/自然语言 → 意图预览 → 报告预览/导出、表格下载
  └─ 历史页签：列表/详情/重新导出/下载表格（仅本人；超管可看全部）
        │
        ▼
AnalyticsController（/api/ai/analytics）
  ├─ IntentService        自然语言 → 结构化意图（白名单；规则兜底）
  ├─ DatasetCollector     按权限收口取数（复用既有口径函数/服务）
  ├─ dataset-facts.ts     纯函数事实包（程序算数）
  ├─ AnalyticsService     组织报告 / 多 sheet 工作簿；配额与降级
  └─ AnalyticsStore       落库 + StorageService 存文件
        │
        ▼
PostgreSQL：AiAnalyticsReport（报告正文 + 事实 JSON + 表格文件 key）
本地磁盘：ai-analytics/<projectId>/<safeName>.xlsx
```

### 2.1 数据集/指标注册表（单一事实源）

新增零依赖 `ai/analytics/dataset-registry.ts`：key、中文名、说明、支持作用域、期间字段、读取权限、Excel 列定义、报告章节、默认选中。模型 prompt、权限过滤、前端下拉、报告章节、Excel 列共用这一份定义。

| key | 中文名 | 期间字段 | 权限 | 复用现有口径/服务 | 报告章节 |
|---|---|---|---|---|---|
| `project.base` | 项目概况 | 无 | `project:view` | `Project` + `localDayKey` | 项目概况 |
| `contract.summary` | 合同汇总 | `signDate` | `contract:view` | `resolveChainAmounts`、`buildScmFacts` | 合同情况 |
| `contract.detail` | 合同清单 | `signDate` | `contract:view` | `resolveChainAmounts`、`deriveLedgerAmounts` | 合同情况 |
| `settlement.summary` | 结算汇总 | `settleDate` | `settlement:view` | `notDraft`、`actualAmount ?? amount` | 结算与资金 |
| `settlement.detail` | 结算单清单 | `settleDate` | `settlement:view` | `notDraft` | 结算与资金 |
| `settlement.ledger` | 结算台账 | `settleMonth` | `settlement:view` | `SettlementLedger`、`deriveLedgerAmounts` | 结算与资金 |
| `payment.records` | 付款记录 | `payDate` | `payment:view` | `paidPaymentWhere()` | 结算与资金 |
| `invoice.records` | 发票记录 | `invoiceDate` | `invoice:view` | 新增 `countedInvoiceWhere()`（排除 CANCELLED/RED） | 结算与资金 |
| `contract.fulfillment` | 履约进度 | `asOf` | `contract:view` | `deriveContractFulfillment`、`isMilestoneOverdue` | 履约进度 |
| `cost.profit_loss` | 月度盈亏 | `period` | `cost:view` | `MonthlyProfitLoss(Detail)`、`weightedUnitPrice` | 成本与分包领用 |
| `cost.labor_receiving` | 分包领用汇总 | `period` | `cost:view` | `LaborReceivingService`、`deriveReceivingRow` | 成本与分包领用 |
| `procurement.task` | 采购任务 | `createdAt` | `contract:view` | `TASK_STATUS_LABELS`、`ProcurementTask` | 采购执行 |
| `procurement.result` | 成交/报价 | `createdAt` | `contract:view` | `ProcurementBidder`、评标结论 | 采购执行 |
| `daily.report` | 总日报 | `entryDate` | `daily:view` | `DailyReport`、`SITE_CONFIRM_STATUS` | 日报与收领单 |
| `receipt.order` | 收领单 | `orderDate` | `receipt:view` | `ReceiptOrder(Detail)` | 日报与收领单 |
| `finance.cost` | 保理/逾期利息 | `financingDate` / `settlementMonth` | `finance:view` | `FactoringCost`、`OverdueInterest`、`summarizeOverdue` | 资金费用 |
| `asset.flow` | 资产进出场 | `date` | `asset:view` | `summarizeAssetFlow`、`assetDirectionOf` | 资产进出场 |
| `supplier.concentration` | 供应商集中度 | 累计 | `contract:view` | `buildScmFacts().suppliers` | 供应商结构 |

默认选中：`contract.summary`、`settlement.summary`、`payment.records`、`invoice.records`；最多 8 个数据集。

**口径铁律**：每个数据集只允许一份实现；注册表条目标注复用来源；新增 `aiAnalyticsParity.spec.mts` 断言「事实总量 = `buildScmFacts` 总量」等。

### 2.2 意图解析（模型只做选择，不产出数字/ID/日期）

```ts
type AiPeriodPreset =
  | 'this_month' | 'last_month' | 'this_quarter' | 'this_year'
  | 'last_30_days' | 'last_90_days' | 'ytd' | 'all' | 'custom';

interface AiAnalyticsIntent {
  version: 1;
  scope: { mode: 'current' | 'selected' | 'all'; mentions?: string[] }; // 不接收模型给出的 ID
  period: { preset: AiPeriodPreset; from?: string; to?: string };       // from/to 仅 UI 可选，模型只能给 preset
  datasets: string[];                    // 注册表 key，最多 8
  groupBy: 'project' | 'month' | 'supplier' | 'contract';
  detail: 'summary' | 'detail' | 'both';
  focus: Array<'payment_risk'|'invoice_gap'|'cost_overrun'|'schedule'|'supplier_concentration'|'procurement'|'asset'>;
  outputs: { report: boolean; workbook: boolean };
  reportKind: 'monthly' | 'project' | 'brief' | 'custom' | 'comparison';
  compare: boolean;
  notes?: string;                        // ≤300 字，只进写作提示
  rawText?: string;                      // ≤2000 字，落库回看
}
```

硬约束：

1. **模型不输出项目 ID**：只允许输出项目名称/简称提示（`mentions`），服务端在有权限项目里匹配；匹配不到进 `warnings`。
2. **模型不输出日期**：只输出 `period.preset`；`from/to` 由服务端按本地时区计算（新增 `ai/common/period.ts`，从 `ReportService` 抽出）。
3. **模型不输出金额/数量/百分比**；未知 dataset/focus/preset 一律丢弃并进 `warnings`。
4. **前端结构化选择优先**：用户显式选的范围/期间/数据集覆盖文本解析结果。
5. 解析失败/AI 关闭：规则解析兜底（`intent-rules.ts`：关键词 → 范围/期间/核心数据集/focus），`source:'rules'`。

新增 AI 用途 `intent`（`AI_PURPOSES` + `AI_MODEL_INTENT`）：短 JSON、便宜模型；同步更新 `aiPurposeModel.spec.mts`（4 → 5 用途）。

### 2.3 事实包与报告

```ts
interface AiAnalyticsFacts {
  version: 1; generatedAt: string; asOf: string;
  scope: { mode: string; label: string; projects: Array<{id,code,name}>; projectCount: number };
  period: { from: string | null; to: string; label: string; preset: string };
  comparePeriod: { from: string; to: string; label: string } | null;
  totals: { /* 合同/结算/付款/开票/应付/欠票/逾期/日报/采购/成本/资产/资金费用 */ };
  byProject: AiAnalyticsProjectFacts[];
  datasets: AiAnalyticsDatasetFact[];   // 每个数据集：summary + 前 20 行 + totalRows/truncated
  risks: Array<{ code; level: 'RED'|'YELLOW'|'INFO'; text }>;
  warnings: string[];
}
```

- 跨项目核心指标**直接复用 `buildScmFacts()`**（累计口径）；**期间口径**由新纯函数按业务日期过滤；当 `period.preset = 'all'` 时，新结果必须与 `buildScmFacts` 逐项一致（parity 断言），避免两套口径。
- 单项目窗口统计抽共享函数（`common/period.ts` + 现有 `projectStats`），`ReportService` 与 analytics 共用。
- **报告 = 程序生成的标题/范围/口径说明/数据表 + 模型撰写的分析段落**。模型按章节返回 JSON：
  `{ "sections": { "二、经营总览": "…", "四、合同情况": "…" }, "advice": ["…"] }`
  - 服务端只接受已知章节键；缺失章节用确定性模板补齐；未知章节丢弃。
  - 模型正文过 `auditNumbers`（含用户 `notes` 里的数字）；对不上 → **整段模型叙述丢弃**，保留程序表格，返回 `discardedNumbers`。
  - AI 未配置/失败/无 `ai:use`/无数据 → 确定性模板报告，`source:'template'`，页面不空窗。
- **表格 = 确定性多 sheet 工作簿**，不经模型；与报告共用同一事实包，数字一致。
- 项目数很多时，报告表格按签约额取 Top-N + 「其余 N 个项目合计」一行；Excel 全量（受行数上限）。

### 2.4 表格：填报扩展 + 工作簿生成

**A. 上传模板智能填报（扩展现有链路）**

- `field-catalog.ts` 新增字段域：`period.*`（本期发生额）、`cross.*`（全部/多选项目聚合）、`ledger.*`、`cost.*`、`procurement.*`、`asset.*`、`daily.*` 等关键标量。
- `ResolveContext` 增加 `scope`（current/selected/all + projectIds）与 `period`；`resolve()` 按域分派到 `DatasetCollector` / 既有服务。
- `forms/inspect`、`forms/fill` 接受 `scopeMode/projectIds/from/to`；跨项目需 `dashboard:view` + `projectMember` 收口；跨项目时不提供 `contract.*/supplier.*` 字段；缺少期间/范围时 400。
- 前端填报页签顶部增加「填报范围」与「期间」控件；跨项目时明确提示「填入的是汇总值」。
- 字段目录膨胀：先按上下文过滤再给模型；截断时在 `aiMessage` 明说「有 N 个字段因长度未列出」；必要时只提高 `AI_MAX_FIELDS` 默认值（调优项仍只认 env）。

**B. 按需求直接生成多 sheet xlsx（确定性）**

- `workbook-builder.ts`：事实包 → sheet 模型（列/行/汇总/截断标记/安全 sheet 名），用 `StyledExcelService.withWorkbook()` 或 `exportTable` 落成 xlsx。
- 上限：单数据集明细 ≤5000 行、工作簿 ≤20 万单元格；超出截断并进 `warnings`。
- 文件名净化；数据一律写字符串/数值，不生成公式（防注入）；sheet 名走 `sanitizeSheetName`。

**C. 行级表格填充（多行报表模板，Phase 4）**

- `form-scan.ts` 增加表区识别：表头行（连续 ≥2 个已知列标签）+ 下方连续空行。
- 用户选择表区对应的数据集与列映射；服务端按 scope 取行逐行写入（必要时插行并复制样式），行数不足补空、数据多于空行追加或截断并回报；上限 2000 行。
- 与单值填充共用权限过滤与跳过回报。

### 2.5 留存（业务确认：落库 + 历史列表）

新增 `AiAnalyticsReport`（迁移 `20261112120000_ai_analytics_report`）：

```prisma
model AiAnalyticsReport {
  id                   String    @id @default(cuid())
  projectId            String
  createdBy            String?   // 用户 ID 快照（不建 User 关系，用户删除后历史仍在）
  createdByName        String?
  title                String
  kind                 String    // 'report' | 'workbook'
  rawText              String?   @db.Text
  intentJson           Json?
  scopeJson            Json?
  datasetKeys          String[]  @default([])
  factsJson            Json?
  warningsJson         Json?
  unknownNumbersJson   Json?
  discardedNumbersJson Json?
  scopeMode            String?
  projectCount         Int       @default(0)
  periodFrom           DateTime?
  periodTo             DateTime?
  periodLabel          String?
  compare              Boolean   @default(true)
  narrative            Boolean   @default(false)
  source               String?   // 'llm' | 'template'
  markdown             String?   @db.Text
  hasReport            Boolean   @default(false)
  workbookKey          String?   // StorageService 相对键，绝不接受客户端传入
  workbookName         String?
  workbookSize         Int?
  hasWorkbook          Boolean   @default(false)
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  project              Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@index([projectId, createdAt])
  @@index([projectId, createdBy, createdAt])
  @@index([createdBy, createdAt])
}
```

- `Project` 增加反引用 `aiAnalyticsReports AiAnalyticsReport[]`（新 `xxxId` 必须有 relation）。
- **访问控制**：`projectId` 一律取 `@ProjectId()`，不接受 body 传入；列表/详情只返回 `createdBy = 当前用户`；超管可 `all=1` 看全部。越权记录返回 **404**（不泄露存在性）；详情/导出时**重新校验**数据集权限（权限被收回后历史也看不到）。
- 表格文件 `StorageService.save(buffer, { sub: 'ai-analytics/<projectId>' })`，只存返回 key；下载统一走 `GET /ai/analytics/:id/workbook`（鉴权 + 归属校验），不暴露 `/api/files` 直链。
- **不自动删文件**（`product-decisions.md`：文件清理=只读审计 + 人工确认）。若提供删除记录，只删 DB 行，文件留作孤儿由 `storage-audit.mjs` 盘点；详情里说明这一点。
- 记录是**快照**：重新生成 = 新增一条，不覆盖。
- 计数同步：`CLAUDE.md` §2 的 model 数（62 → 63）与增量迁移列表、`docs/development.md` 统计、`docStats.spec.mts` 一并更新。

### 2.6 权限、配额与降级

- 路由：GET（datasets/history/detail/download）用 `ai:view`；POST（plan/report/workbook）用 `ai:use`（与既有 `report/generate`、`forms/*` 同口径）。
- service 二次校验：所选数据集的权限**并集**；跨项目（>1 或不指定）额外 `dashboard:view`；项目集合按 `projectMember` 收口，无权项目跳过并 `warnings`，全被跳过则 403/400。
- 配额：`plan` 的 LLM 一次、`report` 的意图 + 叙述两次上游调用**共享一次配额**；失败/整段降级 `quota.refund()`；`workbook` 不调模型、不扣配额。
- 降级：AI 停用/坏 JSON → 规则意图 + 确定性报告；数据集无数据 → 该节写「无数据」并进 `dataGaps`（不当作 0）。
- 审计：POST 端点自动进 OperationLog；新增写入只有 `AiAnalyticsReport`，不写任何业务单据。
- 大范围：项目上限 50（显式多选 >50 → 400；全部项目按成员范围取），明细行/单元格上限见 §2.4 B。

## 三、接口设计

统一前缀 `/api/ai/analytics`：

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/datasets?scope=` | `ai:view` | 按用户权限过滤的数据集注册表 + `deniedDatasets` + `crossProjectAllowed` |
| POST | `/plan` | `ai:use` | `{ text?, scope?, period?, datasets?, focus?, outputs? }` → `{ intent, warnings, unknownTerms, unknownDatasets, deniedDatasets, projects, source }`；LLM 失败回落规则解析 |
| POST | `/report` | `ai:use` | `{ text?, intent?, scope?, period?, datasets?, focus?, notes?, narrative?, compare? }` → `{ id, persisted, intent, scope, period, comparePeriod, sections, markdown, facts, unknownNumbers, discardedNumbers, warnings, source, usage }`；成功落库 |
| POST | `/workbook` | `ai:use` | 同 report，另可带 `reportId?`（挂到已有报告记录上）；返回 `{ id, fileName, size, sheets, warnings, reportId }`；文件存 StorageService 并落库；不调模型 |
| GET | `/` | `ai:view` | 历史列表：`page,pageSize,keyword,kind=report\|workbook,from,to,all?`；默认当前项目 + 本人；超管 `all=1` |
| GET | `/:id` | `ai:view` | 详情（本人或超管；复核数据集权限） |
| GET | `/:id/export?format=docx\|pdf` | `ai:view` | 用存档 Markdown 重新排版导出，不重新取数 |
| GET | `/:id/workbook` | `ai:view` | 下载存档 xlsx（只按记录 key 读取） |
| DELETE | `/:id` | `ai:view` | 仅本人/超管；**只删 DB 记录**，文件留给存储审计（不自动删） |

> UI 的「同时生成报告和表格」= 先 `POST /report` 拿 `id`，再 `POST /workbook { reportId }`：工作簿挂到**同一条记录**（`hasReport=true, hasWorkbook=true`），共用同一份事实包、数字同源。不带 `reportId` 时新建一条 `kind='workbook'` 记录。

表单填报扩展：

| 方法 | 路径 | 新增入参 |
|---|---|---|
| POST | `/api/ai/forms/inspect` | `scopeMode=current\|selected\|all`、`projectIds`、`from`、`to` |
| POST | `/api/ai/forms/fill` | 同上；跨项目聚合值由服务端取；缺期间/范围 400 |

> 不新增权限码（沿用 `ai:view/ai:use`），避免 seed/存量库迁移。

## 四、文件级改动清单

### 后端（新增）

- `server/prisma/migrations/20261112120000_ai_analytics_report/migration.sql`：建表 + 3 索引 + Project 外键。
- `server/src/modules/ai/analytics/analytics.types.ts`：意图/事实/数据集行/风险类型（零依赖）。
- `server/src/modules/ai/analytics/dataset-registry.ts`：注册表（零依赖）。
- `server/src/modules/ai/analytics/dataset-facts.ts`：`buildAnalyticsFacts` / `buildDatasetFact` / `analyticsFactsToMarkdown` / `analyticsFactNumbers` / 风险规则（纯函数）。
- `server/src/modules/ai/analytics/dataset-collector.service.ts`：Prisma 取数；项目收口；并行查询；行数上限；复用 `buildScmFacts` / 已导出服务。
- `server/src/modules/ai/analytics/analytics.service.ts`：编排 plan/report/workbook；配额；降级；落库。
- `server/src/modules/ai/analytics/analytics-store.service.ts`：记录 create/list/detail/delete + 访问控制 + StorageService。
- `server/src/modules/ai/analytics/workbook-builder.ts`：事实包 → sheet 模型（纯函数）。
- `server/src/modules/ai/analytics/analytics-prompt.ts`：章节骨架 + 事实摘要 + 「只写叙述不写表格」。
- `server/src/modules/ai/analytics/analytics.controller.ts`：全部端点与下载头。
- `server/src/modules/ai/intent/intent.types.ts` / `intent-rules.ts` / `intent-prompt.ts` / `intent.service.ts`：意图草稿、规则解析、prompt、LLM 解析与退款。
- `server/src/modules/ai/common/period.ts`：本地日期、preset、对比期（从 `ReportService` 抽出）。
- `server/src/modules/ai/common/contract-roots.ts`：链根解析（从 `scm-facts.ts` 提取，供新事实层复用）。

### 后端（修改）

- `server/prisma/schema.prisma`：`AiAnalyticsReport` + `Project.aiAnalyticsReports`。
- `server/src/modules/ai/ai-config.ts`：`AI_PURPOSES` 增加 `intent`。
- `server/src/modules/ai/ai.module.ts`：注册新 controller/service；`imports` 增加 `CostModule`（复用 `LaborReceivingService`）等。
- `server/src/modules/ai/ai.controller.ts` / `ai.service.ts`：`forms/*` 接收 scope/period 并透传。
- `server/src/modules/ai/field-catalog.ts`：新增 `period`/`cross` 作用域与模块字段；`AiFieldDef.permission?`；`filterFieldsByPermission` 支持覆盖权限。
- `server/src/modules/ai/field-resolver.service.ts`：`ResolveContext` 增加 scope/period；分派到 collector/既有服务。
- `server/src/modules/ai/report.service.ts`：复用 `common/period.ts`；导出方法供历史重新导出。
- `server/src/modules/ai/analysis/scm-facts.ts`：改用提取后的 `contract-roots.ts`（行为不变，spec 回归）。
- `server/src/constants/statuses.ts`：新增 `countedInvoiceWhere()`（与 `paidPaymentWhere()` 并列）。
- **口径修复（业务 2026-11-12 确认随本期一并修）**：`FieldResolverService.projectStats`、`ReportService.windowNumbers` 与 `ledger.service.ts` 的发票合计排除 `CANCELLED/RED`（抽 `countedInvoiceWhere()`）；`windowNumbers` 区间新签金额改合同链口径（主合同 `amount` + 已签补充协议 `changeAmount`）；结算/日报期间改用业务发生日（`settleDate` / `entryDate`）。旧报告重新生成时数字可能小幅变化，页面「口径说明」与 `docs/development.md` 同步写明。
- `server/src/constants/menuTree.ts`：新增 `ai-analytics` → `/ai/analytics`，`ai:view`。

### 前端（新增）

- `web/src/pages/AiAnalytics.tsx`：页签「生成 / 历史」。
- `web/src/components/ai/analytics/GeneratePanel.tsx`：范围、期间、数据集、自然语言、意图预览、报告预览/导出、表格下载。
- `web/src/components/ai/analytics/HistoryPanel.tsx`：列表/筛选/分页/详情抽屉/重新导出/下载表格。
- `web/src/components/ai/analytics/ScopePeriodPicker.tsx` / `DatasetPicker.tsx` / `FactSummary.tsx`。
- `web/src/components/ai/AiFormFillPanel.tsx`：从 `AiAssistant.tsx` 抽出的填报面板，支持 scope/period。
- `web/src/utils/reportExport.ts`：统一 blob 下载与文件名解析（消除现有两处重复）。

### 前端（修改）

- `web/src/components/Sider/menuConfig.ts`、`web/src/constants/routePermissions.ts`、`web/src/router.tsx`：`/ai/analytics` 三处接线（加后端 menuTree 共五处）。
- `web/src/api/modules.ts`：意图/记录/事实/工作簿类型 + `aiApi.analytics*`；扩展 `inspect/fill` ctx。
- `web/src/pages/AiAssistant.tsx`：改用抽取后的填报面板；可加入口跳转。
- `web/src/pages/AiReportPanel.tsx`：`ReportMarkdown` 替换 `MiniMarkdown`（消除重复）。

### 测试（新增）

纯函数 spec：

- `aiDatasetRegistry.spec.mts`：key 唯一、权限/列/章节完整、默认数据集存在。
- `aiIntent.spec.mts`：规则解析、preset、scope、未知 dataset/focus 进 warnings、模型 ID/数字/日期被拒。
- `aiAnalyticsFacts.spec.mts`：草稿/失败/退款/作废/红冲排除、补充协议只计 `changeAmount`、分母 0 → null、按项目汇总、与 `buildScmFacts` 总量对齐。
- `aiAnalyticsMarkdown.spec.mts`：章节/表格生成、数字对账、编数整段丢弃、空数据降级、截断提示。
- `aiAnalyticsWorkbook.spec.mts`：sheet 模型、汇总、行数上限、sheet 名净化、不生成公式。
- `aiFieldCatalogScope.spec.mts`：新增字段、字段级权限、跨项目字段可用性、缺期间报错。
- `aiAnalyticsAccess.spec.mts`：记录访问矩阵（本人/同项目非本人/超管/越权 404）、数据集权限复核。

DB 集成 spec：

- `aiAnalyticsScope.int.spec.ts`：真实成员收口、无 `dashboard:view` 拒绝、合同/供应商筛选不越权。
- `aiAnalyticsStore.int.spec.ts`：落库、列表默认自己、超管 all、详情/导出权限、StorageService 写入/读取。

修改：`aiPurposeModel.spec.mts`（4 → 5 用途）；`docs/development.md §5` 清单与计数；`CLAUDE.md` §2 model/迁移计数与列表。

### 文档

- `docs/03-API接口清单.md` 补端点；`docs/local-storage-structure.md` 补 `ai-analytics/<projectId>/`；`docs/user-guide.md` 补使用说明；`docs/component-api.md` 补组件/API。
- `.claude/rules/product-decisions.md` 登记本次决策（落库/历史/仅本人可见/不自动删文件/无新权限码）。

## 五、分期实施计划

### Phase 1：注册表 + 意图规则 + 数据模型

- 新模型 + 迁移 + `Project` 反引用；`common/period.ts`、`contract-roots.ts` 提取。
- `countedInvoiceWhere()` 与口径修复（业务已确认）：发票排除作废/红冲（projectStats / windowNumbers / ledger）、链口径新签金额、业务发生日；补回归断言。
- 注册表、意图类型/规则解析；`GET /datasets`、`POST /plan`（规则路径）。
- 出口：迁移已应用且列已落地；`docStats` / `schemaDanglingRefs` 通过；`GET /datasets` 按权限过滤；`POST /plan` 把「全部项目今年合同结算付款简报」解析为 `scope=all, this_year, 核心数据集, brief`；未知项进 warnings；两个 build + `npm test` 绿。

### Phase 2：确定性报告 + 落库 + 历史（无模型也可用）

- `DatasetCollector` + `buildAnalyticsFacts` + 确定性 Markdown；`POST /report`（`narrative=false`）+ 落库。
- 历史列表/详情/导出 Word/PDF + 访问控制；跨项目收口。
- 前端「生成」「历史」基础版。
- 出口：单项目/多选/全部均能生成确定性报告；成功后历史出现记录；本人可见、同项目非创建人 404、超管 all 可见；导出用存档 Markdown；越权项目跳过并提示；无 `dashboard:view` 跨项目 403；`test:int` 绿；headless 渲染。

### Phase 3：自然语言意图 + 模型叙述 + 对账

- 新增 `intent` 用途；`IntentService` LLM 解析 + 规则兜底；章节 JSON 叙述 + `auditNumbers` + 降级。
- 前端意图预览、warnings/unknown/discarded 展示。
- 出口：一段话 → 意图预览 → 报告；模型只选数据集/期间/范围；编数字时报告仍可用并列出 `discardedNumbers`；AI 停用/超时不空窗；配额退款；`aiPurposeModel.spec` 5 用途通过。

### Phase 4：工作簿 + 填报扩展 + 行级填充

- `workbook-builder` + `POST /workbook` + StorageService 落库 + 下载端点。
- `field-catalog`/`field-resolver` 的 `period.*`/`cross.*` + `forms/*` scope/period + 前端控件。
- 行级表格填充（表区识别 + 列映射 + 逐行写入 + 上限）。
- 出口：xlsx 可打开且 sheet/汇总与报告一致；模板可用本项目/全部项目/期间字段回填；行级填充在一张项目对照表上真填成功；历史可下载表格。

### Phase 5：全模块覆盖与收口

- 补 cost/procurement/receipt/finance/repayment/labor/material/asset/supplier 数据集与 parity/集成测试。
- 文档计数、API 清单、user-guide、storage 结构、rules 登记。
- 出口：全模块数据集各有断言；两个 build + `npm test` + `test:int` 全绿；重启后端真打；headless 1280/375 双视口核验；提交推送。

## 六、风险与防错

| 风险 | 对策 |
|---|---|
| **口径漂移** | 注册表 + 单一事实层；复用既有纯函数/服务；`aiAnalyticsParity.spec` 断言与 `buildScmFacts`/台账一致 |
| **新旧报告数字变化** | 口径修复经业务确认；「口径说明」写明已签链、业务发生日、发票排除作废/红冲；回归断言锁定新口径，旧记录不追改（历史快照） |
| **IDOR / 跨项目越权** | `projectMember` 收口；`projectId in allowedIds`；记录非本人/非同项目 404；详情/导出复核数据集权限；模型不输出 ID |
| **模型乱选/编数字** | 意图白名单 + 枚举；模型不输出 ID/数字/日期；程序生成表格；叙述过 `auditNumbers`，失败整段丢弃 |
| **Prompt 注入** | 用户文本只作数据；系统提示忽略其中指令；意图经 schema 归一化；`notes` 截断；不拼 SQL |
| **Token/超时** | 意图 prompt 只给注册表元信息；报告 prompt 只给汇总 + 每数据集前 8 行；超时沿用 `llm-client`；失败降级模板 |
| **大数据量** | 项目上限 50；明细 ≤5000 行、工作簿 ≤20 万单元格；聚合优先 `groupBy`；截断并 warning |
| **Excel 安全** | `sanitizeSheetName`；数据不生成公式；文本长度上限；文件名净化；UTF-8 下载头 |
| **文件越权/穿越** | 只存 `StorageService` 返回 key；下载按记录 key；不接受客户端 key；既有 `..`/绝对路径校验 |
| **落库失败丢产物** | 报告保存失败 `persisted:false` + warning；工作簿 DB 失败删刚写文件并 500 |
| **文件清理政策** | **不自动删文件**；删除记录只删 DB，孤儿文件交 `storage-audit.mjs` 人工处理 |
| **页面/菜单漂移** | 五处接线；`routePermissionParity.spec.mts` 锁定 |
| **文档计数漂移** | 同步 `CLAUDE.md` model/迁移计数与列表、`docs/development.md §5`；`docStats.spec.mts` 必跑 |

## 七、验收方案

1. `cd server && npx prisma migrate dev --name ai_analytics_report && npx prisma generate`；复查表、索引、外键已落地；`prisma migrate status` 干净（禁 `db push`）。
2. `cd server && npm run build`、`cd web && npm run build` 退出码 0。
3. `cd server && npm test` 全绿；新增 spec 已登记 `docs/development.md §5`，`docStats.spec.mts` 通过。
4. `cd server && npm run test:int` 全绿（成员收口、期间边界、口径 parity、记录访问控制）。
5. `docker compose -f docker-compose.dev.yml restart server` 后真打：
   - `GET /api/ai/analytics/datasets`；
   - `POST /plan`（「汇总全部项目今年合同、结算、付款和发票，出一份给领导的简报」）；
   - `POST /report`（单项目、多选、全部各一次）；
   - `GET /api/ai/analytics?page=1&pageSize=20`；
   - `GET /:id`、`GET /:id/export?format=docx`；
   - `POST /workbook`、`GET /:id/workbook`；
   - `POST /api/ai/forms/inspect` 与 `/fill`（scope=all + 期间）。
6. 重点核验：报告每个数字都能在 `facts` 找到；`discardedNumbers` 为空或已降级；历史默认只出现自己；同项目非创建人 404；超管 `all=1` 可见；xlsx 可被 ExcelJS 打开且汇总与报告一致；删除记录后文件仍在（交审计）。
7. 三种降级各验一次：AI 停用、上游坏配置、模型返回坏 JSON（必须出确定性结果 + warning）。
8. 前端 Edge headless + CDP：1280×900 与 375×812 渲染 `/ai/analytics`（生成/历史页签）与扩展后的填报页签，无横向溢出、无 console.error。
9. 权限：无对应数据集权限时生成被拒；无 `dashboard:view` 跨项目 403；成员外项目跳过并提示；历史详情不可越权。
10. 完成后按惯例自动提交并推送（SSH）。

## 八、明确不做

- 多轮对话/追问与会话上下文（历史记录是单次快照，不是对话）。
- 项目内共享/可见范围配置（历史仅本人可见，超管例外）。
- 自动执行写操作（生成即改业务数据）——保持只读；写库仍只走文件登记的「人工确认」。
- 向量检索/语义搜索、多 provider 抽象层、流式输出、MQ/调度器。
- 按组织/区域分组统计（无组织维度，需先建模型）。
