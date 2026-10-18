# 单据关系与复用边界（四域扩展剩余任务）

> **何时加载**：改动收领单 / 总日报 / 结算单 / 付款 / 发票链路，做合同履约进度、合同归档、
> 进出场（资产台账）相关需求，或对“采购订单 / 对账”该不该建表拿不准时。
>
> 背景：原 `docs/05-四域扩展可行性评估.md` 已删除（决策留痕见 `git log`）。其中
> 「采购下游 = 采购订单 → 到货验收 → 对账」的草图**与业务口径不符**，以本文件为准。

## 1. 单据主链路

```
采购任务 / 招标定标 → 合同（签订）
                       ↑ 外部采购订单（系统外，不进入本项目）
合同 → 收领单（到货验收）→ 总日报 → 结算单 → 付款 / 发票 / 台账
```

三条硬口径：

1. **采购订单与对账由外部系统承接**：本项目**不建** `PurchaseOrder` / `PurchaseOrderItem` /
   `Reconciliation`。合同与外部订单的对应关系默认由合同附件 / 备注承载；若业务后续要求结构化引用，
   单独立项（见 §8 的按需项）。
2. **总日报是结算的前置**：没有总日报不生成结算单。
3. **结算明细从总日报带出，允许修改**：带出后的明细是结算单自身的可编辑快照，
   服务端重算金额，但人可以在结算单上改数量 / 单价 / 税率。

## 2. 复用边界（硬约定）

| 单据 | 复用对象 | 结论 |
|---|---|---|
| 收货 / 到货验收 | `ReceiptOrder`（+ `ReceiptOrderDetail`） | ✅ 复用；保存即幂等推送总日报、自动入资产台账 |
| 总日报 | `DailyReport` | ✅ 复用；**结算量的来源**；现场确认状态按 `settlement.require_confirmed` 过滤 |
| 结算 / 付款 | `Settlement` / `PaymentRecord` | ✅ 复用；结算明细从总日报带出、可改 |
| 发票 | `Invoice` | ✅ 复用；与结算单按结算期关联 |
| 采购订单 | 外部系统 | ❌ 本项目不建表、不接口 |
| 对账单 | 外部系统 | ❌ 本项目不建表；对账 ≠ 结算 |

## 3. 真相源

| 数据 | 唯一来源 | 备注 |
|---|---|---|
| 合同当前金额 | `common/utils/contract-chain.ts` 的 `resolveChainAmounts()` | 主合同 + Σ 补充协议 `changeAmount`（带符号） |
| 结算量基线 | **总日报行**（`DailyReport`） | 收领单推送的行与手工录入行同属来源；非「已确认」行在开关开启时不计入 |
| 结算金额 | `Settlement.actualAmount`（排除草稿） | 明细修改后由服务端汇总回写 |
| 付款金额 | `PaymentRecord` | 排除失败 / 退款（`PAYMENT_EXCLUDED_STATUSES`） |
| 发票金额 | `Invoice.amountWithTax` | — |
| 履约进度 / 交付进度 | **派生视图** | 由上述数据聚合，不反写任何单据 |

> 派生金额的三态约定沿用台账：分母未知或为 0 → `null`（前端显示 `-`），显式 0 是真实 0。
> 见 `.claude/rules/backend-conventions.md`「派生金额的三态契约」。

## 4. 结算生成口径（已按总日报落地，2026-10-18）

- **生成来源 = 期内 `DailyReport` 行**（`contractId` 非空、`entryDate` 在结算期内），按合同分组；
  **有总日报才有结算单**，手工录入的日报行与收领单推送的行同属来源。
- `settlement.require_confirmed` 开启时（默认）只取 `confirmStatusCode = CONFIRMED` 的日报行。
- **明细按 `materialBaseId` 聚合**：数量 = Σ `settleQty`；金额优先取日报行的 `amountBeforeTax` /
  `amountAfterTax`，缺失时用「单价 × 数量」补算；同物资多行按数量**加权平均**单价。
  明细的含税单价/合价与 `SettlementService.normalizeItem()` 使用**同一公式**，
  保证「表头金额 = Σ 明细合价」；生成后**允许在结算单上修改**。
- **缺 `materialBaseId` 的日报行**无法形成清单项级明细：计入 `skippedRows` 并返回 `warnings`
  （前端提示物资名称），**不静默吞掉**；全部行都带不出明细的合同不生成空壳结算单。
- **收领单只回挂 `settlementId`**（发票/台账按关联归集需要），**不再参与明细金额计算**。
- **幂等**：同合同同期已有结算单 → 跳过；本期迟到的收领单补挂到已有结算单、**不改金额**。
- 实现：纯函数 `server/src/common/utils/settlement-from-daily.ts` +
  `settlement.service.generateForPeriod()` / `previewPreviousPeriod()`。
  锁定：`server/test/settlementFromDaily.spec.mts` +
  `server/test-integration/settlement-period-link.int.spec.ts`。

## 5. 合同增强：履约进度与归档

### 5.1 履约派生进度（零表，已实施 2026-10-18）

- 一次取数聚合：合同链金额、总日报已收量、结算额、付款额、开票额，
  算出已收比例、已结比例、已付/已结、已付/合同、开票比例、未收数量、待结金额、未付金额。
- 口径：已收 = 总日报 `settleQty`（`settlement.require_confirmed` 开启时只算已确认行）；
  已结排除草稿（`chainSettledTotal`）；付款排除失败/退款；发票 = `Invoice.amountWithTax` 合计。
- 纯函数 `server/src/common/utils/contract-fulfillment.ts`；服务
  `contract-fulfillment.service.ts`；端点 `GET /contracts/:id/fulfillment`；
  前端「合同查询」详情弹窗的「履约进度（派生）」卡片。
- **不重复**结算 / 付款 / 收货单据；履约是它们的汇总视角（与台账同哲学）。
- 比例**分母未知或为 0 → `null`**（前端显示 `-`），显式 0 是真实 0；超收/超结/超付用负数暴露。
- 计划节点 / 里程碑表 `ContractFulfillment` 属**按需项**，本轮不做。

### 5.2 归档锁定（单向，已实施 2026-10-18）

- `Contract.archivedAt` / `archivedBy`（迁移 `20261107000000_contract_archive`）；**单向归档，不提供解除归档**。
- 归档前检查下游完整性（完整项见 §5.2 下方），未通过则 400 并逐条列出原因；
  检查实现：纯函数 `server/src/common/utils/contract-archive.ts` +
  `contract.service.archiveCheck()`；端点 `GET /contracts/:id/archive-check`、
  `POST /contracts/:id/archive`。
  - 合同未签章；
  - 存在草稿结算单；
  - 存在未完成总结算单；
  - 存在未纳入结算的总日报行 / 收领单（总日报无 `settlementId`，按“该合同存在已确认日报行、
    但无对应结算单/结算明细”判断）；
  - 有下游单据但合同未「已完已结」（`execStatus = DONE_SETTLED`）。
- 归档后锁定范围：

| 模块 | 归档后 |
|---|---|
| 合同本体（改、签章、驳回、删除） | **禁止写** |
| 收领单 / 总日报 / 结算 / 总结算 | **禁止写** |
| 发票 / 付款 | **允许**（事后补录；归档检查给 warning） |
| 读取 / 导出 / 下载签章件 | 允许 |

## 6. 分阶段任务地图

| 阶段 | 任务 | 依赖 | 验收标准 |
|---|---|---|---|
| P0 | 单据关系设计（本文件） | — | 口径评审通过；不再出现订单 / 对账表规划 |
| P1 | ✅ **结算生成口径对齐（已实施 2026-10-18）**：总日报 → 结算明细 | P0 | 无总日报不生成；明细来自总日报且可改；手工日报行参与；同期唯一、重跑幂等、台账刷新不回归 |
| P2 | ✅ **合同履约派生进度（零表，已实施 2026-10-18）** | P1 | 比例三态正确；结算排除草稿、付款排除失败 / 退款；跨项目隔离 |
| P3 | ✅ **合同归档锁定（已实施 2026-10-18）** | P2 | 下游未完成阻断并列原因；归档后写操作 400、读取导出可用；单向 |
| P4 | ✅ **进出场（只做物资，已实施 2026-10-18）** | — | 不建新表；费用行不混入；只统计物资 |
| P5 | 按需后续 | — | H5 / jsonb / 招标立项前置 / `DailyReport.exitDate` / `ContractFulfillment` / 解除归档等，不在本轮 |

P1 → P2 → P3 为顺序依赖；P4 可独立并行。

## 7. 进出场口径（只做物资，已实施 2026-10-18）

- 进场：`ReceiptOrder`（送货 / 实收）→`DailyReport.entryDate` + `AssetLedger`（采购 / 调入）。
- 出场：`AssetLedger` 的转出 / 处置行（`TRANSFER_OUT` / 处置类 `sourceCode`）。
- **不建新表、不做人员 / 车辆 / 门禁 / 扫码**；费用类来源（如调拨费、维修费）不计入进出场数量。
- 实现：纯函数 `server/src/common/utils/asset-flow.ts`；资产台账列表支持
  `direction=IN/OUT/FEE` 筛选；`GET /assets/flow-summary` 返回进场/出场/费用汇总；
  前端资产台账页顶部展示汇总卡片。
- `DailyReport.exitDate` 为按需增强，本轮不做。

## 8. 按需项（本轮不做）

- 移动刚需页 H5 精简版。
- 半结构化字段改 PG `jsonb`。
- 招标立项前置状态。
- `DailyReport.exitDate`。
- `ContractFulfillment` 节点 / 里程碑表。
- 合同解除归档（需独立权限与审计决策）。
- 外部采购订单的结构化引用（订单号字段 / 接口），以及按订单对账。
- 收领单超收的 BLOCK 策略（当前若做，只预警不阻断）。

## 9. 变更检查清单（改这条链路时逐条过）

1. `schema.prisma` 是否真的需要新表 / 新列？先对照 §2 的复用边界，**不要复活订单 / 对账表**。
2. 改模型必须出迁移，加外键在同一迁移内清洗数据（见 `.claude/rules/backend-conventions.md`）。
3. service 查询显式带 `projectId`；更新用 `assertVersion`；写入用 `pickFields` 白名单。
4. 结算 / 台账口径改动必须同步 `docs/development.md §5` 的 spec 清单与计数，
   并跑 `test:int`（金额 / 状态 / 关联改动强制）。
5. 前端页面 / 菜单 / 权限 / 路由四处同步（菜单权威在后端 `menuTree.ts`）。
6. 活文档计数（model / 业务模块 / 增量迁移 / spec）与 `docStats.spec.mts` 保持一致。
