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
- 设计与实际落地的两处偏差（唯一键为何含 `bidderName`、报价为何按列而非按轮次）见 docs/05 §6.2、
  docs/02。相关锁定：`statusCodes.spec.mts`（`bidder_status` 常量 ↔ 字典）。

## 采购总清单 → 合同起草清单

- `contract.service.seedDraftFromProcurementItems()` 把 `ProcurementTotalItem` **幂等**带入
  `ContractDraftMaterial`（`qty ← qty`、`priceBeforeTax ← planPrice`（控制价）、`unit ← unit`；
  税率按**合同主表税率**预填，含税单价与暂定含税合价服务端重算，与 `draftSave` 同口径）。
- 多单位场景**每份合同都带入同一份清单**（由用户按成交单位裁剪）；带入失败只记日志、**不阻断**合同生成。
- 细节见 docs/09 §8.1。

## 两套变量体系（互不相通）

- **采购模板变量**（前端 `constants/procurementVariables.ts` + 各 `utils/procurement*.ts` 的
  `build*VariableValues`）与**合同模板变量**（后端 `template.service.generate()` 的 `values`）
  由**不同代码**替换、规则不同：同名 `{{项目名称}}` 在两处取值来源不同。
- 金额类变量名**必须带单位后缀**（`预计采购金额(万元)` / `(元)`）——同名不同单位即视为缺陷；
  旧名经 `PROCUREMENT_VAR_ALIASES` 单向兼容，面板只展示规范名。
- 改/加变量必须**同时**改面板定义与取值表，否则 `procurementVariables.spec.mts` 红。
- **每个变量面板都要传 `variableScope`**（`RichTextEditor` 的 prop）：面板顶部据此提示"这套变量只在
  采购文档 / 合同正文里生效"——不标体系时作者会插错体系的变量，且**静默不替换**（正文留着占位符，
  只有预览才高亮）。由 `procurementVariables.spec.mts` 的源码扫描锁定。
- ⚠️ **项目字段名 ↔ 文档上下文名不一致**：`GET /projects/:id` 返回 `name` / `nameAbbr` / `code` /
  `materialOrigin`，而采购文档上下文用 `projectName` / `projectAbbr` / `projectCode` / `materialOrigin`，
  映射在 `utils/procurementTaskDocs.ts` 的 `baseCtx`——**误用旧名会让公共变量静默取空**。
