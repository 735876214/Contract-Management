# TODO.md · 剩余任务

> **本文件只列「未完成」任务**：完成一项就**直接删除条目**（不用 `[x]` 勾选、不写"已完成"段落，
> 否则文件只增不减）；历史以 `git log` / PR 为准。
> 改动前必读的约定与踩过的坑见 [CLAUDE.md](CLAUDE.md)（**唯一事实源**；历史经验已在其中固化）。
> **基准**：main 分支 2026-10-14（**不在此逐批枚举已完成项**——那会随每次提交过期，历史见 `git log`）。

图例：`需业务澄清` 未澄清前不要动手 · `需外部条件` 等基础设施/凭据 · `可直接开工` 纯工程项

> 分组依据是**阻塞条件**（而不是"优先级"）：标着"可直接开工"却全是阻塞项，会让人排错期。
> **例外**：「四域扩展」的评估与主链路口径已定（决策留痕见 `git log` 与
> [.claude/rules/document-relationships.md](.claude/rules/document-relationships.md)）；
> 内部按**先后**标注 —— 「待实施」→「按需」，不做优先级排序。
> 说明：**发票「查验」仅用于登记核对（把发票信息录入后标记为已查验），不做验真、不接第三方查验服务**，
> 故此项已按业务澄清从待办中移除。

## 需业务澄清（澄清前不要动手）

（当前无。`dashboard:view` 口径已定：类级要求该权限，`todos` 继续豁免——「我的任务」不是统计报表。
实现见 `server/src/modules/dashboard/dashboard.controller.ts`。）

- **「未填」在预警口径里算不算 0**（2026-11-24 评估发现，**需业务确认后再动手**）：
  `Number(...) || 0` 在 `server/src` 有 42 处。求和场景下 null→0 是**有意**口径
  （`common/utils/group-sum.ts` 注释写明「与 `num() || 0` 一致」）；但 `dashboard/amount-alert.ts:71-72、131-132`
  把「未填的结算额 / 付款额」当 0 去算**比率与阈值**，会误报或漏报预警。
  要定的是：这两类（求和 / 阈值判定）是否该分两套写法——求和可兜 0，判定应按「未知、不参与判定」（宁漏勿误）。

## 需外部条件（基础设施 / 凭据 / 他人配合就绪即可做）

- **AI 预警的生产召回率评测**：目前只有合成夹具评测（召回 100% / 误报 0），真实单据上的召回率
  需要真实数据 + 人工标注。工具链已就绪、**不需要改代码**：
  `npm run anomaly:export -- --project <id>` 导出 → 人工标注 `hit` → `npm run anomaly:score`
  （门槛不达标脚本退非 0）。标注纪律见 [docs/AI应用落地计划.md](docs/AI应用落地计划.md) §10，
  方法与命令见 [docs/AI应用评测报告-6-9-结算异常预警.md](docs/AI应用评测报告-6-9-结算异常预警.md) §6–§7.1。
  真实数据到位后，顺带按 [docs/development.md](docs/development.md) §5.2 复核预警面板
  **有数据时**的手机端排版（演示库样本为 0，目前只验证过空态；表结构已补 `scroll`）。
- **LLM 措辞质量人工评分**：网关一直没配密钥，目前只验证了模板降级链路；配好密钥后补一次人工打分
  （结论是否点名到单据、动作是否可执行、有没有编数字）。
- **HTTPS 部署**：NAS 反代 + 证书。当前 JWT 走 httpOnly Cookie，无 HTTPS 时既有安全面问题，
  也拿不到 `getUserMedia`（现场拍照）。见
  [docs/09-移动端可行性评估-375px实测.md](docs/09-移动端可行性评估-375px实测.md) §4 阶段 C。

## 可直接开工（工程项，按性价比排序）

> 2026-11-22 质量审计的落地情况：**类型安全（strict）、ESLint 门禁、大服务拆分**已由
> `2863841`（P0–P1 质量整改）在 main 上完成；`PR #32` 落地隔离 fail-closed / 稳定错误码 / 分页口径；
> `PR #31` 补的是它没覆盖的**口径单一实现**与**样板去重**（导出/导入/列表筛选、keyword 过滤、文件下载各收敛一处，
> 台账合规筛选改窄投影，lint 预算收到 0，int 覆盖 27 → 32）。
> 2026-11-24：**前端 API 类型层**（台账/付款/结算/合同/付款手续 5 个域的主路径，类型见 `web/src/api/types/`）
> 与**金额口径**（`Number(x.toFixed)` 收敛到 `@cms/calc` 的 round2/round4；`/contracts` 的 Decimal 字符串改成 number）
> 已由 PR #44–#50 收口，配套 4 份 `api-shape-*.int.spec.ts` 双侧契约锁。下面只留**尚未做**的。

### AI 助手 P3-C：写操作草案确认（**已决策暂缓，等 A/B 稳定后再议**）

现状：P3-A 问数（只读）与 P3-B（流式 + 只读工具）**已落地**；**任何写库动作都没有**——
本仓口径是「AI 一期不落业务数据，最坏结果是下载到一个错的表」（见 `ai.controller.ts` 文件头）。

真要做，前置条件缺一不可（缺任何一条都不要开工）：
1. 草案逐字段 diff（旧值 → 新值）展示，**默认全部不勾选**；
2. 确认令牌绑定用户 + 幂等键（重复提交不重复写）；
3. 失败可回滚、且失败不得留下半条数据；
4. 只允许**新建**类操作（合同/供应商），**不许**改金额、改状态、删单；
5. 写入路径必须带发起方标记（`OperationLog.actorTool`，该字段已就绪，MCP 已在用）。

阻塞原因：需业务明确承担「AI 写库出错」的责任边界，并确认上述 5 条作为产品口径写进
`.claude/rules/product-decisions.md`。在那之前只做只读。

- **门禁豁免与 fan-out 聚合器复核**（2026-11-24 审计 P3 备忘，非缺陷）：
  2026-11-28 收紧门禁后 `check-query-limits` 有 **79 处**内联 `// @no-limit:`（豁免表仍为 0），
  模块边界检查点名 `archive`(10) / `receipt-order`(6) 两个高 fan-out 聚合器，已逐条复核：
  确实都是「口径本身需要全量」（归档导出、下拉选项、链根解析、合计行）。**未解决的部分**：
  多数注释只写了「为什么必须全量」，没写「什么时候该重看」——即没有触发条件（如「合同数 > 2000 时改为分页/异步导出」），
  下次复查时补。`archive` / `receipt-order` 若继续长，考虑把聚合搬到 `src/query/` 层收口。
- **采购 6 个单据页面仍高度同构**：`web/src/pages/Procurement/{FrameworkExplanation,PreMeetingMinutes,Notice,
  Document,ResultReport,PriceCompare}.tsx` 各 720–990 行，跨文件 10 行以上的重复窗口 24–44 处/对。
  变量映射与下载 helper 已收口（`utils/projectVars.ts` / `utils/blobDownload.ts`），页面骨架仍应向
  `components/procurement/ModuleListPage` + `EditorTabPage` 继续收敛。

- **前端剩余约 180 个 API 端点仍是 `any`**（2026-11-24 类型化收口的剩余面）：
  台账 / 付款 / 结算 / 合同 5 个域的主路径已 typed（`web/src/api/types/`），其余仍是 `http.get<any, any>`，
  集中在 `procurementTaskApi`(30) / `aiApi`(25) / `financeApi`(19) / `invoiceApi`(15) / `receiptOrderApi`(13) /
  `laborApi`(12) / `settlementApi` 的辅助端点(16)。**一个域一份 PR**，照 `types/ledger.ts` 的路子：
  类型文件 + api 泛型 + `api-shape-<域>.int.spec.ts`（用 `test-integration/helpers.ts` 的
  `readWebTypeKeys()` / `readQueryParamKeys()`）。辅助端点若返回「操作结果包」（`skipped/created/提示文案`），
  等真正消费时再收，别为类型而类型。
- **页面内的临时求和闭包绕过 calc 聚合（6 处）**：`ledger.service.ts:318`（`sumBy`）、
  `cost/monthly-profit-loss.service.ts:325`、`contract/pay-ratio.ts:102`、`ai-insight/report.service.ts:332`、
  `ai-insight/field-resolver.service.ts:291`、`ai-insight/analytics/dataset-facts.ts:295` 各有 `reduce(... + Number(...))`。
  内存侧单一实现在 `packages/calc/aggregate.ts`、SQL 侧在 `common/utils/group-sum.ts`，这些是漏网。
  建议先替换成 calc 原语，再给 eslint 加一条「`src/modules/` 内金额列求和必须走 calc」的限制
  （按 `reduce` 里 `+ Number(` 的形态拦），否则下次还会长回来。
- **日期 UTC 规则在 web 侧没有门禁**：`server/eslint.config.mjs` 的 `no-restricted-syntax`
  （`new Date(x.startDate|endDate)`）2026-11-24 已从 `src/modules` 扩到整个 `src/`，但 `web/` 不在其中；
  实测 4 处同名写法：`web/src/utils/preMeetingMinutes.ts:212`、`procurementResultReport.ts:132`、
  `procurementDocument.ts:86`、`procurementNotice.ts:110`（`const d = v instanceof Date ? v : new Date(v)`）。
  当前 +08:00 下不显现偏移，但浏览器换时区会把 `2026-01-05` 打成 `2026-01-04`，而这是**印在正式单据上**的日期。
  加法：`web/eslint.config.mjs` 加同款规则 + 4 处改用 `@cms/calc/time` 的本地日原语。
- **两个超长方法是拆分后的残留**：`settlement.service.ts:1010 generateForPeriod` **235 行**
  （起始日检查 → 读日报/收领单 → 双重分组 → 逐合同排序加锁 → 已有单补挂 → 明细构建 → 4 类 skipped 统计 →
  事务建单 → 提交后刷台账 → 12 字段结果对象）、`procurement-task.service.ts:500 publish` **210 行**。
  加法：`generateForPeriod` 抽 `generateOne(contractId, ctx)`，把 6 个松散 `skipped*` 字段收成 `GenerationStats`；
  纯搬运、无口径改动，改完必须跑 `test:int`（`settlement-link` / `settlement-item` 覆盖这条链）。

## 四域扩展（已收口，不再立项）

> 全部已实施完毕，**已完成事项不留在本文件**（见文首规则）。单据关系、复用边界与已定口径
> 见 [.claude/rules/document-relationships.md](.claude/rules/document-relationships.md) 与
> [.claude/rules/procurement-and-tender.md](.claude/rules/procurement-and-tender.md)，
> 历史以 `git log` 为准。当前**无遗留待办**；有新需求按上方三档新增。

## 本文件的维护方式

1. **完成即删除**：任务做完直接从本文件删条目，不留 `[x]`、不追加"最近完成"章节。
2. **新增任务**：只写「未完成、可执行」的事项，附证据（文件/接口/命令）与**阻塞原因**；
   按阻塞条件分流到三档之一：`需业务澄清` / `需外部条件` / `可直接开工`。
3. **需要长期记住的约定与坑**：**不要写在本文件**——写进 [CLAUDE.md](CLAUDE.md)（改动前必读的硬约定）
   或 [docs/development.md](docs/development.md)（做法与命令）；本仓库已不再保留 `.workbuddy/memory/`
   之类的历史记忆目录（2026-10-14 清理，内容含已废弃的 SQLite/双 schema 指引）。
   同理，**本文件不写「现为 N 个 spec / N 项断言」这类会过期的数字**：活文档的计数由
   `server/test/docStats.spec.mts` 锁，历史报告标「当时快照」即可（见 [CLAUDE.md](CLAUDE.md) §8 末尾）。
4. 与 [CLAUDE.md](CLAUDE.md) 的「验收铁律」配合使用：改完必须过构建 + 单测 + 真打请求。
