# 招标域与采购变量细则

> **何时加载**：改招标/投标/评标、成交报告、采购清单带入合同清单，或动采购模板变量面板/取值表时。

## 招标域：结构化行是事实源，JSON 只是发布快照

- **导入双写**：导入「响应单位情况汇总表」时，同一事务内既写 `ProcurementResultReport.suppliers`
  （JSON 快照，发布文档口径不变）又写 `ProcurementBidder` 结构化行（唯一键 `(taskId, bidderName)`）。
  **单位与两轮报价以导入表为准**，面板只维护「状态 / 投标文件 / 最终确认价 / 备注」四项。
- **定标 = 勾选「拟推荐成交候选人」**：服务端把勾中的单位置为 `WON` 并写 `finalPreTaxTotal`；
  取消勾选回落「入围（通过第一轮）/ 已递交」（纯函数 `bidderStatusWhenNotWon()`）。
  ⚠️ **生成合同的单位与金额只从结构化中标行取**（`candidatesFromBidders()` → `resolveContractUnits()`），
  **别改回读 JSON `candidates`**——快照可能过期；`test-integration/tender-bidders.int.spec.ts` 有一条
  「刻意篡改快照也不采信」的判据挡着。
- **存量回填**由 `ensureBiddersFromSnapshot()` 在首次读取/生成合同时**幂等**完成（不写一次性迁移脚本）；
  重新导入时**有评标记录的单位拒绝删除并报错**（静默丢评估数据比报错更糟）。
- 设计与实际落地的两处偏差（唯一键为何含 `bidderName`、报价为何按列而非按轮次）已注明在
  `schema.prisma` 的 `ProcurementBidder` 注释与 docs/02。相关锁定：`statusCodes.spec.mts`（`bidder_status` 常量 ↔ 字典）。

## 采购总清单 → 合同起草清单

- `contract.service.seedDraftFromProcurementItems()` 把 `ProcurementTotalItem` **幂等**带入
  `ContractDraftMaterial`（`qty ← qty`、`priceBeforeTax ← planPrice`（控制价）、`unit ← unit`；
  税率按**合同主表税率**预填，含税单价与暂定含税合价服务端重算，与 `draftSave` 同口径）。
- 多单位场景**每份合同都带入同一份清单**（由用户按成交单位裁剪）；带入失败只记日志、**不阻断**合同生成。
- 幂等与失败不阻断的细节见 `contract.service.seedDraftFromProcurementItems()` 的注释。

## 三套变量体系（互不相通）

同一个 `{{项目名称}}` 在**采购文档 / 合同正文 / 单据**里由**不同代码**替换、取值来源也不同。
**语法已统一为 `{{变量名}}`**（单花括号与英文遗留 key 的支持已移除），但**取值表是三份独立实现**：

| # | 体系 | 定义处 | 取值（替换）处 |
|---|---|---|---|
| 1 | **采购模板变量** | 前端 `constants/procurementVariables.ts` | 各 `utils/procurement*.ts` 的 `build*VariableValues()` |
| 2 | **合同模板变量** | `ContractTemplate.variables`（`varKey`/`varLabel`/`sourceType`）+ 前端 `pages/Clauses.tsx` 的 `VARIABLE_GROUPS` | 后端 `template.service.generate()` 的 `values` → `template-render.ts` |
| 3 | **单据模板变量** | `modules/doc-template/doc-template-vars.ts`（付款单）、`modules/final-settlement/final-settlement-vars.ts`（总结算单） | 同模块 service 的 `renderDocx()`；前端面板在 `web/src/constants/docVariables.ts` |

**通用约定**：

- 金额类变量名**必须带单位后缀**（`预计采购金额(万元)` / `(元)`）——同名不同单位即视为缺陷；
  旧名经 `PROCUREMENT_VAR_ALIASES` 单向兼容，面板只展示规范名。
- 改/加变量必须**同时**改面板定义与取值表，否则 `procurementVariables.spec.mts` 红。
- **每个变量面板都要传 `variableScope`**（`RichTextEditor` 的 prop）：面板顶部据此提示"这套变量只在
  采购文档 / 合同正文 / 单据里生效"——不标体系时作者会插错体系的变量，且**静默不替换**（正文留着占位符，
  只有预览才高亮）。由 `procurementVariables.spec.mts` 的源码扫描锁定。
- ⚠️ **项目字段名 ↔ 文档上下文名不一致**：`GET /projects/:id` 返回 `name` / `nameAbbr` / `code` /
  `materialOrigin`，而采购文档上下文用 `projectName` / `projectAbbr` / `projectCode` / `materialOrigin`，
  映射在 `utils/procurementTaskDocs.ts` 的 `baseCtx`——**误用旧名会让公共变量静默取空**。

**采购侧逐模块「定义 ↔ 取值」对照**（改采购文档取值前先看这张表）：

| 模块 | 取值表 | 备注 |
|---|---|---|
| INITIATE（采购发起） | — | **不产出 Word**，故 `PROCUREMENT_MODULE_VARS.INITIATE` 定义为**空**（曾误留 3 个变量：面板能插、却永远不替换） |
| PRE_MEETING | `buildPreMeetingVariableValues` | 用 `预计采购金额(万元)` |
| NOTICE | `buildNoticeVariableValues` | `采购编号` 以**公告自身字段为源** |
| DOCUMENT | `buildDocumentVariableValues` | `采购编号` 继承公告值、空则回退任务编号 |
| RESULT_REPORT | `buildResultReportVariableValues` | 用 `预计采购金额(元)`——**与采前会单位不同，故把单位写进变量名区分** |
| PRICE_COMPARE | `buildPriceCompareVariableValues` | 含明细表变量 |
| FRAMEWORK | `buildExplanationVariableValues` | 含询价情况 / 价格对比 / 成本分析三张表 |

- **公共变量 7 个**（`PROCUREMENT_COMMON_VARS`，无前缀）：项目名称 / 项目简称 / 承接单位 / 项目所在省市 /
  工程地点 / 项目地址 / **物资产地**（取自 `Project.materialOrigin`，与合同模板同名变量口径一致）。
- ⚠️ **跨模块同名即"同源共享"，必须显式登记**：`server/test/procurementVariables.spec.mts` 的
  `SHARED_ACROSS_MODULES` 白名单强制列出（防新增"同名异义"）。其中 `采购编号` 以公告为源、文件侧继承；
  `采购时间` 见下一条。
- **单据模板特有**：变量面板**只对已接 Word 生成路径的分类开放**（当前付款单 / 总结算单），
  其余三类（结算单 / 保理单 / 逾期利息）本期只做模板存放——插了变量也不会被替换，故面板层就不给。
  前后端变量名由 `docVariables.spec.mts` 锁「逐条一致 + 金额名带单位」；`{{结算明细表}}` 是**表格占位符**
  （与合同模板的 `{{物料编码清单}}` 同类，值由服务端生成 HTML 表格）。

**「采购时间」的口径（业务已确认，别再提议合并）**：公告的 `ProcurementNotice.procurementTime` 与采购文件的
`ProcurementDocument.procurementTime` 是**各自文件的编辑时间，不是同一个"采购时间"** ——
两处独立可编辑、各自落库是**有意为之**（变量同名但分属不同模块的面板，不会插错）。

**核对命令小抄**（改动变量体系时先跑一遍）：

```bash
sed -n '1,80p' web/src/constants/procurementVariables.ts        # 采购变量定义（公共 + 各模块 + 别名）
grep -n "VariableValues" web/src/utils/procurement*.ts          # 各模块取值表
grep -n "renderTemplate\|pendingPlaceholders" server/src/modules/template/template.service.ts
grep -rhoE "process\.env\.[A-Z_]+" server/src | sort -u         # 环境变量（.env.example 需同步）
```

