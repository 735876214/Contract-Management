# 规则索引（改动前先查这张表）

> **何时加载**：接到任何编码任务时先读本文件。规则细则**不会自动加载**——
> 命中下表场景时**先读对应文件再动手**；产品决策见 [product-decisions.md](product-decisions.md)。

## 按改动场景路由

| 改动场景 | 先读 | 该文件覆盖的坑 |
|---|---|---|
| 后端 service / 迁移 / 结算 / 台账 / 日志 / 领用·盈亏 | [backend-conventions.md](backend-conventions.md) | 六处同步 · 外键清洗 · 乐观锁 · 写白名单 · 日志脱敏 · 主合同判定（**`list[0]` 不是主合同**）· 日报行是结算量唯一来源 · 金额上限（**无金额 = 无上限**）· 台账列宽是字符宽 · 存储单一入口 · 结算期归属 · 分包单位领用/月度盈亏口径 |
| 业务口径（做不做、怎么算） | [product-decisions.md](product-decisions.md) | 无流程引擎 · 单表付款台账 · 补充协议链金额 · 结算期 · 付款安排派生比例 · 总结算收口 · 领用自动/盘点手填 · 月度盈亏快照 · 外部采购订单边界 · 总日报→结算 |
| 单据链路 / 合同履约·归档 / 进出场 | [document-relationships.md](document-relationships.md) | **采购订单与对账在外部系统**（不建表）· **总日报是结算前置与明细来源**（明细可改；现状 `generateForPeriod` 按收领单）· 唯一真相源 · 履约零表派生 · 归档单向与锁定范围 · 进出场只做物资 |
| 招标·投标·评标 / 采购变量 | [procurement-and-tender.md](procurement-and-tender.md) | 导入**双写** · 定标 = 勾选候选人 · 生成合同只从结构化中标行取价 · 变量名必须带单位 · 三套变量体系 · 项目字段名两套 |
| 导入 / 模板与占位符 | [import-and-templates.md](import-and-templates.md) | 两阶段「全成功或全失败」· 心跳回收 · 幂等去重（**命中后不得再 execute**）· 占位符只认 `{{}}` · **种子模板有两处** |
| 前端页面·组件·样式·路由 | [frontend-conventions.md](frontend-conventions.md) | `perm()` 工厂 · 视觉只改 token 层 · **断点两层：外壳看视口 / 组件看容器** · 列显隐两条路 · 菜单权威在后端 · 多页签与编辑器页签 |
| 测试 / 改金额·状态·导入 | [testing.md](testing.md) | 两套测试分工（改金额/状态/导入**必跑 `test:int`**）· `.mts` 三条硬约束 · 新增 spec 要同步 docs/development.md §5 清单与计数 |

## 最高频 5 条

1. 改模型必须出迁移（**禁 `prisma db push`**）；加外键先在同一迁移内清洗数据。
2. 项目隔离：新增查询/写入**自己带 `projectId`**。
3. 状态 code 写常量（`SETTLEMENT_STATUS.DRAFT`），**不裸写** `'DRAFT'`。
4. 前端色值只来自 token 层；**断点分两层**：外壳看视口（`useResponsive()`），组件看容器（`.cq`）。
5. 改完必须过 `web build` + `server build` + `npm test`，并**重启后端真打一次请求**。
