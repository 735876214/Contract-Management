# AI 应用落地计划（7×11 矩阵裁剪版）

> 基准：2026-10-23。输入 = `附件1 AI应用矩阵清单.xlsx`（7 域 × 11 方向 = 77 个课题）+ 本仓库真实表结构与 AI 底座勘察。
> 本文件只回答三件事：**做哪几个课题、按什么顺序、每步怎么验收**。

---

## 0. 结论先行

| 定位 | 课题 | 一句话理由 |
|---|---|---|
| **主线一（首选落地）** | **6-9 重复结算与异常支付预警** | 采购→合同→履约→结算→付款→发票 数据链最完整，纯库内计算 + LLM 措辞，零文档解析、零 embedding、零外部对接 |
| **主线二** | **3-9 异常报价与价差识别预警** | `ProcurementBidder` 两轮报价 + 税金 + `ProcurementTotalItem` 预算齐全，采购模块刚建完，接 AI 时机最好 |
| **主线三** | **4-9 采购合同履行偏差预警** | `ContractFulfillment.planDate/actualDate/statusCode` 直接可算逾期节点，几乎不需要新数据 |
| **演示线（不占主线）** | 7-11 供应链运营分析智能助理 | 复用 `report.service.ts` 即可出成品，**好演示、难落地**；排在最后 |
| 明确不做 | 1-x 全系、X-5/X-6、5-5/5-9、X-7/X-8 大部分 | 见 §6 |

---

## 1. 底座复用清单（决定了「每个课题 ≈ 一个 prompt + 一个接口 + 一个面板」）

| 已有能力 | 位置 | 本计划怎么复用 |
|---|---|---|
| LLM 调用（含 JSON 抽取 / 纯文本） | `server/src/modules/ai/llm-client.ts`（`callChat` / `chatJson` / `chatText` / `extractJsonBlock`） | 全部预警的「措辞层」 |
| 配额（每用户滑动 1h）+ 失败退还 | `ai/ai-quota.ts`（`consume` / `refund`） | 新接口同样扣额度；**规则层不调模型 ⇒ 不扣** |
| 上游配置 / 密钥只写不读 | `ai/ai-setting.service.ts`、`ai/ai-config.ts` | 不动 |
| 「程序算数、模型说话」范式 | `ai/report.service.ts` + `report-facts.ts` + `report-prompt.ts` | **预警层直接照抄该范式**，并把 `unknownNumbers` 对账机制沿用 |
| 读权限二次过滤（只 `ai:use` 不该看到金额） | `report.service.ts:104`、`ai.service.ts:319` | 预警接口同样要求 `settlement:view` / `payment:view` 等业务读权限 |
| 消息中心落点 | `modules/notification/notification.service.ts`（`send()`，字段 `type/bizType/bizId/projectId`） | 命中结果落一条摘要通知，复用现有 30s 轮询徽标 |
| 系统参数（阈值/容差） | `common/services/sys-param.service.ts` | 金额容差、金额占比阈值全部走 SysParam，**不硬编码** |
| 前端权限/菜单/路由四处接线 | `server/src/constants/menuTree.ts`、`web/src/components/Sider/menuConfig.ts`、`web/src/constants/routePermissions.ts`、`web/src/router.tsx`、`web/src/api/modules.ts` | 新增面板必须五处同步（菜单权威在后端） |
| 权限码种子 | `server/src/seed.ts:210-216`（`ai:view` / `ai:use`） | 若新增 `ai:anomaly` 之类要同步 seed + `Permission` 表 |

**结论：不新建 AI 基础设施，只新增「规则层 + 措辞层 + 面板」。** 每个课题预估 3–6 人日。

---

## 2. 三个必须先解决的现状缺口（本轮新查明）

### 2.1 库是空的 —— 这是整个计划的**头号风险**

2026-10-23 实测 `cms-postgres`（9080 那套）：

```
Contract 0 · Settlement 0 · PaymentRecord 0 · Invoice 0
ProcurementBidder 0 · ContractFulfillment 0 · Notification 0
Project 3 · Supplier 85 · SysParam 3 · OperationLog 42
```

**没有任何业务单据，就没有可命中的异常，也无法度量漏报。** 因此 P0 必须先造评测夹具，否则后面全是"看起来能跑"。

另：`docker-compose.dev.yml` 的 postgres（:15432）当前**未启动**，开发/集成测试前需先起。

### 2.2 两条规则按现有表结构要改写（原方案里的 R1 / R6 落地不了）

- **R1「同合同 + 同结算期间 + 金额相近」**：`SettlementLedger.settlementId @unique` + 业务口径「同合同同月只允许一张结算单」已经**从库里挡掉了**最常见的重复。真正剩下的重复形态是：
  1. 同一合同的结算单**跨月指纹重复**（金额、明细组合高度重合）；
  2. 同一 `materialBaseId` 在多张结算单上重复计量（现有「结算量闸门」只管总量，管不了**同一批实物被两次计价**）；
  3. `FinalSettlementItem` 的月度快照金额与对应月度 `Settlement.actualAmount` 不一致。
  → R1 改成上述三条子规则，判定阈值走 SysParam。

- **R6「付款手续审批完成时间晚于付款流水时间」**：`PaymentProcedure` **没有审批时间字段**（只有 `code/settleCumAmount/paidCumAmount/unpaidAmount/payDate/statusCode`）。→ 改成**快照-台账偏离**检测：`PaymentProcedure` 的开累结算/开累付款是保存时快照，若与实时重算的「Σ结算 / Σ付款」偏离超过容差，说明事后补录未回改单据（这正是原 R6 想抓的业务实质）。

- **R2 超付**：`Contract` 无质保金字段；用 `ContractExt.currentPayRatio`（派生付款比例）+ `ContractExt.settlementPayRatio` 折算「应付上限」，超付判定才有口径。

### 2.3 预警结果一期不落库

复用 `Notification`（无迁移成本）即可满足「看得见、点得动」。**不建 `AiFinding` 表**——一旦要「已处置/已忽略/已指派/误报标记」，才需要新表 + 迁移（属二期，见决策点 D2）。

---

## 3. 分期计划（单人 20 人日 / 4 周；双人并行可压到 2.5 周）

| 里程碑 | 内容 | 工作日 | 日期 | 出口条件（硬） |
|---|---|---|---|---|
| **M0** | P0 评测夹具 + 规则层骨架（纯函数，无 DB） | D1–D2 | 10-26 ~ 10-27 | 夹具脚本一条命令灌出 2 项目 × 3 合同 × 8 期数据；注入 12 条已知异常 + ground-truth JSON；`npm test` 绿 |
| **M1** | P1 6-9 后端跑通（6 条规则 + 接口） | D3–D5 | 10-28 ~ 10-30 | `test:int` 命中率 ≥ 90%、误报 ≤ 2；接口真打一次返回 findings |
| **M2** | P1 6-9 前端面板 + 联调 | D6–D8 | 11-02 ~ 11-04 | 五处接线完成；headless 真渲染核验；两个 build 退出码 0；提交推送 |
| **M3** | P1 评测报告（召回/误报/成本） | D9 | 11-05 | 出一页评测结论，含每条规则的漏报样本 |
| **M4** | P2 3-9 异常报价与价差 | D10–D12 | 11-06 ~ 11-10 | 同上四类验收 + 面板 |
| **M5** | P3 4-9 履约偏差预警 | D13–D15 | 11-11 ~ 11-13 | 同上 |
| **M6** | P4 7-11 跨项目供应链分析助理（演示版） | D16–D19 | 11-16 ~ 11-19 | 生成一份跨项目 Markdown → 导出 docx/pdf，数字对账 `unknownNumbers` 为空 |
| **收口** | 文档（development.md §5 计数、API 清单）、`CLAUDE.md` 迁移计数、回归 | D20 | 11-20 | 全套命令绿 + 推送 |

> 若只有 2 周窗口：只做 **M0–M3（6-9 全链路）**，其余砍掉。6-9 单独就是一个完整可交付成果。

---

## 4. P1（6-9）详细工作分解

### 4.1 规则层（先算，绝不让模型算数）

新目录 `server/src/modules/ai/anomaly/`：

```
rules-payment.ts      # 纯函数：输入已聚合的行数据，输出 Finding[]
anomaly-types.ts      # Finding { code, level, entity, entityId, facts, amountDiff? }
anomaly-prompt.ts     # 措辞层 prompt（输入仅 findings JSON）
anomaly.service.ts    # Prisma 聚合查询 + 调规则 + 调 LLM + 降级
```

| 规则 | 判定（全部用 Decimal / 整数分计算，禁浮点比较） | 命中等级 |
|---|---|---|
| R1-a 跨月指纹重复 | 同合同两张结算单：`actualAmount` 差 ≤ 容差 且 `settleDate` 跨月 且 明细 `materialBaseId` 集合 Jaccard ≥ 0.8 | 高 |
| R1-b 同一物资重复计量 | 同合同同 `materialBaseId`：跨两张以上结算单的 `qty` 合计 > 合同链清单量 × (1+容差) | 高 |
| R1-c 总结算快照偏离 | `FinalSettlementItem.amount` ≠ 对应 `Settlement.actualAmount`（超过容差） | 中 |
| R2 超付 | Σ`PaymentRecord.amount`(同合同, `payDate` ≤ 今日) > Σ`Settlement.actualAmount` × `ContractExt.currentPayRatio` + 容差 | 高 |
| R3 无合同付款 | `PaymentRecord.contractId` 为空，或指向 `execStatus ∈ {TERMINATED, ...}` 的合同 | 高 |
| R4 票款不一致 | 同 `settlementId`：Σ`Invoice.amountWithTax` ≠ `Settlement.actualAmount`（超容差，允许一张结算多张发票） | 中 |
| R5 结算早于验收 | `Settlement.settleDate` < 关联 `ReceiptOrder.orderDate` 最早日 | 中 |
| R6 付款手续快照偏离 | `PaymentProcedure.settleCumAmount/paidCumAmount` 与实时重算值偏离 > 容差（快照未回改） | 中 |

**硬约束**：`rules-payment.ts` 是纯函数、不 import Prisma、不 import 模型，可在 `server/test/*.spec.mts` 里裸跑（`npm test` 门禁）。

### 4.2 措辞层（只做三件事）

`anomaly-prompt.ts` 输出**严格 JSON**（`chatJson` + schema 校验）：

1. 把每条 finding 的 `facts` 翻成业务语言（"合同 HT-2026-018 在 6 月与 7 月各有一张金额 42.8 万的结算单，明细物资完全一致"）；
2. 给风险等级与**建议动作**（复核/退回/补手续/挂起付款）；
3. 生成可下钻的核查清单（指向 `settlementId` / `paymentId`）。

降级：`chatJson` 失败或 schema 不合法 → 直接用模板串渲染 `facts`（保证面板永不空窗，与 `report.service.ts` 同款兜底）。**结果里出现的任何数字都必须在 `facts` 里出现过**，否则抛 `unknownNumbers`（沿用 report 的对账口径）。

### 4.3 接口

```
GET  /api/ai/anomaly/payment?from=&to=&window=   -> { summary, findings[], unknownNumbers[] }
POST /api/ai/anomaly/payment/notify              -> 落 Notification(bizType='AI_ANOMALY_PAYMENT')
```

- 权限：`ai:use` **且** 具备 `settlement:view` + `payment:view`（沿用「只有 ai:use 不能导出经营数据」的教训）。
- 配额：`AiQuota.consume(userId, limit)`，LLM 失败 `refund`。
- 只读：**不写任何业务表**，唯一写入是 `Notification`。

### 4.4 前端

- `web/src/pages/AiAnomaly.tsx`：上「风险摘要卡（按等级计数）」+「命中列表（可展开 facts）」+「建议动作」+「一键生成通知」；只读表格，跳转到结算/付款页带 id 过滤。
- 五处接线：`server/src/constants/menuTree.ts`（AI 助手下加子项或独立一级）、`web/src/components/Sider/menuConfig.ts`、`web/src/constants/routePermissions.ts`、`web/src/router.tsx`、`web/src/api/modules.ts`（`aiApi.anomalyPayment`）。
- 视觉只动 token 层（`DESIGN.md`），不新增硬编码色值。

### 4.5 测试与验收（照 `CLAUDE.md §5` 铁律逐条过）

| 项 | 动作 |
|---|---|
| 纯函数单测 | `server/test/anomaly-payment.spec.mts`：零金额、空合同、跨年期间、容差边界、Decimal 精度、Jaccard 边界、LLM 降级路径 |
| DB 集成测试 | `server/test-integration/anomaly-payment.int.spec.ts`：灌夹具 → 断言 12 条注入异常全部命中、误报 ≤ 2 |
| 活文档 | 新增 spec 同步 `docs/development.md §5` 清单与计数（`docStats.spec.mts` 锁定）；新增迁移同步 `CLAUDE.md §2`（本期预计**零迁移**） |
| 构建 | `cd web && npm run build`；`cd server && npm run build`（看退出码，不 grep "error TS"） |
| 真打 | `docker compose -f docker-compose.dev.yml restart server` 后真调一次 `/api/ai/anomaly/payment` |
| 渲染 | headless（Edge + CDP）+ 前端 `npm run build` 后目视核验 |
| 收尾 | build ×2 + `npm test` + `npm run test:int` 全绿 → 提交推送（SSH） |

---

## 5. P0 评测夹具（M0，别的都靠它）

`server/prisma/fixtures/ai-anomaly.ts`（或 `scripts/` 下独立脚本）：

- 2 个项目 × 3 个合同（1 物资采购 / 1 分包 / 1 服务），每合同 8 个结算期：`Contract → ContractMaterial → ReceiptOrder → Settlement(+Item) → PaymentRecord → PaymentProcedure → Invoice → FinalSettlement`。
- 每类规则**注入 2 条已知异常**，共 12 条真值，输出 `server/test-integration/fixtures/anomaly-truth.json`（`{ code, entityId }`）。
- 全部走 service 层写入（保证闸门被真实通过），不裸 SQL。
- 指标口径（写进 M3 报告）：**召回率 ≥ 90%（12 中 ≥ 11）**、**误报 ≤ 2 条/项目**、单项目扫描 P95 ≤ 3s（规则层）/ ≤ 15s（含 LLM）。

---

## 6. 明确不做（附理由，避免反复讨论）

| 课题 | 为什么不做 |
|---|---|
| 1-1 ~ 1-11 全系（供应商准入/认证/店铺） | `Supplier` 是薄全局表（`name @unique` + 法人/联系人/银行/地址），**没有证照、资质、到期日**，系统也**没有"店铺"实体**。做 1-2/1-9 等于先立一个供应商档案与证照管理项目，不是 AI 课题 |
| X-5 全系（语义检索） | 网关无 `/v1/embeddings`（404），向量能力不存在；替代方案（关键词）价值不足 |
| X-6 全系（以图搜物） | 同上，且无图像入库/向量化链路 |
| 5-5 / 5-9（物流轨迹类） | 库里没有任何物流数据源，只有收货单与验收报告 |
| X-7 / X-8 大部分（画像/预测） | 画像需跨系统行为数据；预测需连续 12 期以上真实历史——当前库为空，做出来就是拟合夹具 |
| X-11 全系（Agent 自主执行） | 只读版可做，写操作要改状态机与权限边界，风险与收益不匹配；7-11 的"助理"止于**生成报告**，不做自动执行 |

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **空库 → 无异常可抓、无法评测** | 计划整体落空 | P0 卡口：夹具 + ground truth 先行，M0 不通过不进 M1 |
| 让模型算金额 → 差额算错、口径漂移 | 财务类系统最致命 | 规则层纯函数 + Decimal；LLM 只允许引用 `facts` 中已有的数字，`unknownNumbers` 非空即视为失败 |
| 结算口径出现"第四套" | 数据打架 | 预警**只读不写**；引用 `backend-conventions.md`「结算 actualAmount 唯一写入点在 settlement.service」 |
| 新权限码漏配 seed/菜单 | 页面进不去或越权 | 权限码 + 五处接线清单化；跟 `routePermissions.ts` 同 PR 提交 |
| LLM 输出不稳定 / 上游挂 | 面板空窗 | 模板串降级 + 配额 `refund` |
| 7-11 挤压主线工期 | 落地成果延期 | 7-11 固定排 P4，且只承诺"生成 + 导出"，不承诺交互式问答 |

---

## 8. 需要拍板的三个决策点

- **D1 顺序**：按本计划（6-9 先落地，7-11 收尾演示）？还是反过来先出可汇报成果？——后者会挤掉 6-9 至少一周。
- **D2 结果持久化**：一期只落 `Notification`（零迁移）；二期是否建 `AiFinding` 表以支持处置状态机？
- **D3 规则阈值归属**：金额容差、Jaccard 阈值、超付比例是否接受"全部进 SysParam 由管理员可调"（默认值写进迁移/种子）？

---

## 9. 实现进度（滚动更新，只记已落地的与偏差）

| 里程碑 | 状态 | 落地物 | 验收证据 |
|---|---|---|---|
| M0 规则层 | ✅ 2026-10-23 | `server/src/modules/ai/anomaly/{anomaly-types.ts, rules-payment.ts}`、真值夹具 `server/test/fixtures/ai-anomaly-payment.fixture.mts`、单测 `server/test/aiAnomalyPayment.spec.mts` | 8 条规则纯函数（金额全 bigint 分/万分之一单位）；夹具 10 条命中真值 + 干净夹具 0 命中；`npm test` 全绿 |
| M1 后端接口 | ✅ 2026-10-23 | `anomaly-config.ts` / `anomaly-prompt.ts` / `anomaly.service.ts`、`GET /ai/anomaly/payment`、`aiAnomalyPrompt.spec.mts` | 744 项测试全绿；假 Prisma 直呼 service：10 条命中、`notEvaluated` 正确、缺 `contract:view` 得 403、非法日期 400、开关关闭不判定；提交 `c84b79d` |
| M2 前端面板 | ✅ 2026-10-23 | `web/src/pages/AnomalyPanel.tsx`、`aiApi.paymentAnomaly`、五处接线 | 两个 build 退出码 0；`routePermissionParity.spec.mts`（菜单↔路由↔权限漂移锁）通过 |
| M3 评测 | ✅ 2026-10-23 | 夹具生成器+评分器 `server/src/modules/ai/anomaly/anomaly-bench.ts`、`server/test/aiAnomalyBench.spec.mts`、报告 `docs/AI应用评测报告-6-9-结算异常预警.md` | 合成集（12 合同 / 61 结算单 / 9 条注入）：**召回 100%、误报 0**，8 个规则码全覆盖；4 001 张结算单判定 101.6 ms；措辞层 1 次调用 / 1 991 字符 ≈ 905 tokens；756 项测试全绿 |
| M3.5 评测执行链路 | ✅ 2026-10-23 | 取数形状唯一事实源 `anomaly-dataset.ts`、真值对账 `anomaly-score.ts`、CLI `server/scripts/export-anomaly-dataset.mts` / `score-anomaly.mts`、单测 `aiAnomalyDataset.spec.mts` / `aiAnomalyScore.spec.mts`、npm 脚本 `anomaly:export` / `anomaly:score` | 夹具反推「行 → JSON → 评分」全链路：10/10、退出码 0；篡改真值后如实产出漏报 1 / 误报 1，收紧门槛后退出码 1 且理由带数字；`export` 缺 `--project`、缺 `DATABASE_URL` 都给可读错误 |
| M4 规则层（3-9） | ✅ 2026-10-24 | `server/src/modules/ai/quote/{quote-types.ts, rules-quote.ts}`、真值夹具 `server/test/fixtures/ai-quote.fixture.mts`、单测 `server/test/aiQuoteRules.spec.mts`、金额原语上提到 `ai/common/money.ts` | 12 个规则码（B1–B7）纯函数，金额全 `bigint` 分；夹具 5 个采购任务 / 12 处注入，干净任务零命中；794 项测试全绿；提交 `41561fe` |
| M4 后端接口 | ✅ 2026-10-24 | `quote-config.ts` / `quote-prompt.ts` / `quote.service.ts`、`GET /ai/anomaly/quote`、`aiQuotePrompt.spec.mts`、`ai/common/{narrative.ts, params.ts}` | 810 项测试全绿；假 Prisma 直呼 service：命中 4 条、`notEvaluated` 5 条、缺 `contract:view` 得 403、开关关闭不判定、坏参数只回落不静默放宽；提交 `bf682fa` |
| M4 前端面板 | ✅ 2026-10-24 | `web/src/pages/QuoteAnomalyPanel.tsx`、`aiApi.quoteAnomaly`、四处接线（后端 `menuTree.ts` / 前端 `menuConfig.ts` / `routePermissions.ts` / `router.tsx`） | `web build` 退出码 0；`routePermissionParity.spec.mts`（菜单↔路由↔权限漂移锁）通过；面板只读，未判定与样本量强制可见 |
| M5 规则层（4-9） | ✅ 2026-10-24 | `server/src/modules/ai/fulfillment/{fulfillment-types.ts, rules-fulfillment.ts}`、真值夹具 `server/test/fixtures/ai-fulfillment.fixture.mts`、单测 `server/test/aiFulfillmentRules.spec.mts` | 8 条规则码（C1–C8）纯函数，日期一律自然日天差；夹具 10 条命中真值（高 3 / 需复核 7）+ 干净合同零命中；边界阈值按「严格大于」逐条锁死 |
| M5 后端接口 | ✅ 2026-10-24 | `fulfillment-config.ts` / `fulfillment-prompt.ts` / `fulfillment.service.ts`、`GET /ai/anomaly/fulfillment`、`aiFulfillmentPrompt.spec.mts` | 837 项测试全绿（76 spec）；两 build 退出码 0；假 Prisma 直呼 service：命中 10 条、`notEvaluated` 正确、缺 `contract:view` 得 403、开关关闭不判定、坏参数只回落并回显 warning |
| M5 前端面板 | ✅ 2026-10-24 | `web/src/pages/FulfillmentAnomalyPanel.tsx`、`aiApi.fulfillmentAnomaly`、四处接线（`menuTree.ts` / `menuConfig.ts` / `routePermissions.ts` / `router.tsx`） | `web build` 退出码 0；`routePermissionParity.spec.mts` 通过；面板只读，未判定与样本量强制可见 |
| M6 事实层（7-11） | ✅ 2026-10-25 | `server/src/modules/ai/analysis/{scm-types.ts, scm-facts.ts}`、单测 `server/test/aiScmFacts.spec.mts` | 跨项目口径纯函数：签约额按合同链（补充协议只算 `changeAmount`）、草稿/失败/红冲全部排除、分母为 0 返回 `null`、未填金额不计但单独提示；11 个单测锁口径（含空数据不抛错） |
| M6 后端接口 | ✅ 2026-10-25 | `scm-config.ts` / `scm-prompt.ts` / `scm.service.ts`、`GET /ai/analysis/supply-chain`、复用 `ai/common/{narrative,params}.ts` 与 `report-facts.auditNumbers` | 跨项目需 `dashboard:view`（单项目只要 `contract:view`）、最多 20 个项目（超出 400）、幽灵项目跳过并提示；假 Prisma 直呼 service 八条验收全过：正文数字对账通过、编 9,999,999 整份退回模板、缺节记 `missingSections`、参数脏值回落、停用短路、越权 403 |
| M6 前端面板 | ✅ 2026-10-25 | `web/src/pages/ScmAnalysisPanel.tsx`、`web/src/components/ReportMarkdown.tsx`（带表格的极简渲染）、`aiApi.supplyChain`、四处接线（`menuTree.ts` / `menuConfig.ts` / `routePermissions.ts` / `router.tsx`） | 面板只读：项目多选 → 生成 → 正文预览 + 事实清单 + 风险点；导出 Word/PDF 复用 `POST /ai/report/export`（同一份 Markdown，不重新生成）；`web build` 退出码 0 |

### 9.1 与计划的偏差（有意为之）

1. **面板做成独立菜单，而不是 AI 助手的页签**。原本先按页签试了一版，又撤回：`menuTree.ts` 与 `menuConfig.ts` 的漂移锁要求两处逐项对齐，页签虽省事，但"结算异常预警"是财务月度核对的**常驻动作**，藏进 AI 助手的第四个页签等于没有入口。最终：`/ai/anomaly` 平级菜单，权限沿用 `ai:view`（**不新增权限码**，Seed 与 `Permission` 表无需迁移）。
2. **权限双层**：路由要 `ai:view`（能进 AI 入口），service 再要 `contract:view`（命中项带合同/结算/付款金额）。与 `report.service.ts` 同口径，避免"能看 AI 面板就能看全公司金额"。
3. **规则数 8 条而非计划的 6 条**：R1 拆成跨期重复 / 同物资重复计量 / 终期快照漂移；R6 从"审批时间晚于付款"（`PaymentProcedure` 没有审批完成时间字段，做不到）改成"开累快照与台账不一致"。
4. **R2 超付口径**：用 `ContractExt.currentPayRatio`（0~1）作上限，比例为空或不在 0~1 的合同**不判定并单独报出**（`notEvaluated`），不用 100% 兜底 —— 兜底等于悄悄放宽规则。
5. **只读、不落 `Notification`**：D2 的"一期落通知"本轮未做。预警自己写库/发消息会在正式使用时产生"谁点的、何时点的"追溯问题，先只读；要提醒由前端下一个工单决定。
7. **M5 的 8 条规则（C1–C8）也是按「库里真有的字段」筛过的**：`ContractFulfillment` 只有计划日/实际日/状态/责任人，所以不做「交付物齐全性」「验收结论一致性」这类需要文档解析的判定；把「已出终期结算却仍有未完成节点」「付款快于履约」这类**跨表自相矛盾**做成规则，才是这套系统独有、且不依赖 AI 的部分。
8. **判定基准日是「服务端今天」，不是查询参数**：预警要回答「现在有没有风险」，让前端传日期会产出「昨天的预警」被当成实时结论；响应里 `generatedAt` 即基准时刻，写进每条事实行，谁看都能对上时间。
6. **评测用合成夹具而不是真实单据**：库里没有任何业务单据（`Settlement` / `PaymentRecord` / `Invoice` 全为 0 行），且 DB 不可达。于是把「评测」拆成两层：**能否落地（成本/规模/规则一致性）现在可测**，**召回率是否达标**必须等真数据。为避免自己造的题自己打满分，夹具生成时同步登记真值（`TruthItem`）并给评分器加了自校准用例（删/加真值必须变成误报/漏报）。
- **7-11 的「模型编数字」处理比 6-9 更狠**：6-9/3-9/4-9 是逐条丢弃命中项或退回模板串，7-11 是**整份正文丢弃**退回确定性汇总。理由：预警是核对清单，读者会逐条核；全景报告是给领导看的叙述文，读者无法分辨哪一句可信，「大部分对、个别编」比整份退回更危险。

### 9.2 尚未闭合的缺口

- **`test:int` 与"真打一次接口"仍未做**：本容器到 `cms-postgres-dev` 的 TCP 可连，但 PostgreSQL 协议握手后即被断开（PG 日志 `could not send data to client: Broken pipe`），`docker exec` 在该 daemon 上报 `NotFound: task … not found`。M1/M2/M4/M5 用"假 Prisma 直呼 service + 两个 build + 漂移锁单测"替代，**DB 侧的查询形状（select/关系名）没被真实 Prisma 校验过**，这是上生产前必须补的一步。
- **headless 真渲染未做**：容器内无 Edge/Chromium，DESIGN.md §5.2 的渲染核验无法执行；面板的视觉与交互未经肉眼确认。
- **生产数据上的召回率仍未测**（M3 只做了规则层的内存版评测）：合成集能证明「实现与设计一致、正常业务不被误伤、规模与成本可测」，但证明不了真实单据的召回。**执行工具已就位（2026-10-23 补齐）**：门控条件一旦解除，只需 `npm run anomaly:export -- --project <id>` 导出 → 人工标注 `hit` → `npm run anomaly:score` 出门槛结果，**不需要改一行代码**；口径见本文 §10、方法见 `docs/AI应用评测报告-6-9-结算异常预警.md` §6。

---

## 10. 评测执行手册（有真实单据时，不改一行代码即可出召回率）

**前置**：能连到有业务数据的库（`DATABASE_URL` 指向它）。

### 10.1 三步

```bash
cd server
set -a && source .env && set +a          # 让脚本拿到 DATABASE_URL（Prisma 读环境变量）

# ① 只读导出（8 张表窄列 → JSON，含规则初判候选）
npm run anomaly:export -- --project <项目id> --out tmp/anomaly-dataset.json \
  [--from 2026-01-01] [--to 2026-12-31] [--contract <合同id>]

# ② 人工标注（把 candidates 复制进 tmp/anomaly-truth.json 后逐条判定，详见 10.2）
#    结构：{ projectId, annotatedBy, annotations: [{ code, entityId, hit, note }] }

# ③ 对账评分（门槛不达标退非 0，可直接挂 CI）
npm run anomaly:score -- --dataset tmp/anomaly-dataset.json --truth tmp/anomaly-truth.json \
  --min-recall 0.9 --max-fp 2 --out docs/AI应用评测报告-6-9-结算异常预警-真值对账.md
```

导出物四块：`meta`（样本量/容差/导出时间）· `rows`（原始窄列）· `input`（规则入参）· `candidates`（规则初判，**仅供标注参考**）+ `notEvaluated`（缺口径的合同，必须一起看）。

### 10.2 标注纪律（决定这份报告有没有价值）

- **不得直接采信 `candidates`**：照抄等于召回恒 100%，评了等于没评。逐条改成 `hit: true/false`。
- **每条 `hit=false` 必须写 `note`**：写清"业务上为什么正常"——这是后面调容差/加规则的唯一依据，否则下次还得重新争一遍口径。
- **补充 `candidates` 没覆盖、但你确实发现的异常**（`entityId` 用单据 id）：这些就是漏报样本，比命中样本值钱。
- **主动撤开样本**：请财务挑"上季度实际出过问题、但没人发现的单"。只挑规则已经抓到的，样本必然有选择偏差。
- 50 条起步；每条规则至少 3 条 hit=true，否则按规则拆分的那一列没有统计意义。

### 10.3 两个防自欺的设计（写在这里，避免将来被"优化"掉）

1. **评分时用 `rows` 重算规则**，不接受数据集里的 `candidates`。这样报告永远描述**当前代码**的行为；改了规则却没有重新导出，会立刻暴露成召回变化，而不是拿一份旧初判冒充新结果。
2. **评分单位是 `(code, entityId)`，并按规则分列给召回**。合计 90% 掩盖"R2 只有 40%"是最危险的读法——那意味着某一条规则上线即不可用，却在总表上被平均掉了。

### 10.4 已做的冒烟验证（2026-10-23，无 DB）

把规则夹具反推成"Prisma 行形状 → JSON 文件 → 评分脚本"，验证链路本身没有断点：

- 真值 = 全部命中 → 10/10，召回 100%、查准 100%、**退出码 0**；
- 把一条真值改成 `hit=false` 并补一条人工漏报 → 召回 90%、误报 1，默认门槛（≥90%、≤2 条）**通过**；
- 收紧到 `--min-recall 0.95 --max-fp 0` → **退出码 1**，理由写明「召回率 90.0% < 门槛 95.0%；误报 1 条 > 门槛 0 条」；
- `anomaly:export` 缺 `--project` / 缺 `DATABASE_URL` → 退出码 1 且错误信息可照做。

由此确认：**剩下的唯一变量是数据，不是代码**。
