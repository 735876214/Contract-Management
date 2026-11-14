# 模块边界（后端 `server/src/modules`）

> **何时加载**：新增/改动后端模块、跨模块调用 service/module、或要把一段逻辑从 A 模块用到 B 模块时。
> 机器契约：`scripts/check-module-boundaries.mjs`（`verify-module` 与 CI 都会跑，秒级）。

## 1. 唯一规则：跨模块只走公开入口

```
server/src/modules/<module>/index.ts     ← 唯一公开入口
```

- 允许：`import { XxxService } from '../<module>';`
- 禁止：`import { XxxService } from '../<module>/<module>.service';`
  （以及 `.module`、`*.excel`、`dto/*` 等任何内部文件）
- 模块内部文件之间照常相对引用，不受影响。
- **例外**：`auth`（JWT / 权限守卫）是横切基础设施，允许深层引用，登记在检查器的 `INFRA_MODULES`。

## 2. 公开入口怎么写

只导出**别的模块真正需要的符号**，不写 `export *`：

```ts
export { SettlementModule } from './settlement.module';
export { SettlementService } from './settlement.service';
```

新增被跨模块使用的符号时，**同时**把它加进 `index.ts`，否则调用方的公开入口 import 会编译失败。

## 3. 聚合器是刻意存在的

`archive` / `ai` 的 fan-out 很大（`archive` 直接读 11 个域的表），这是"全库视角"的报表/分析层，
不是违规；但**仍须走公开入口**。检查器会打印 `fan-out > 5` 的聚合器清单，供审查时判断是否在扩散。

## 3.1 跨域读取统一走 `server/src/query/`

- `archive` 的 11 个域读取已收敛到 `server/src/query/archive-queries.ts`；
  `modules/archive/**` **不得出现 `prisma.<模型>`**，由检查器锁定。
- 新的跨域只读查询按 `<域>-queries.ts` 放进 `server/src/query/`，通过 `server/src/query/index.ts` 导出；
  函数只读、不带事务、每个都显式带 `projectId`。
- AI 分两类：
  - **只读子域**（`ai/analytics` / `ai/anomaly` / `ai/analysis`）**不得依赖业务模块**，
    数据直接在 ai 内查询或走 `query/`；
  - `ai/register.service.ts` 是**刻意的写路径**（复用 `ContractService` / `SupplierService` 的编号唯一、
    名称拼接、字典校验），**允许**依赖业务模块公开入口，不要"优化"掉。

## 4. 不允许模块环

检查器用 Tarjan SCC 检测模块级循环依赖（当前为 0）。出现环时的修法：

1. 把共享逻辑下沉到 `server/src/common/`（纯函数优先）；
2. 或把"聚合读取"改为查询层（read model），不要反向调用写模块；
3. 不要用 `import type` 或延迟 `await import()` 绕过——检查器同时扫静态与动态 import。

## 5. 常见错误

| 现象 | 原因 | 修法 |
|---|---|---|
| `from '../dict/dict.service'` 被判越界 | 绕过公开入口 | 改成 `from '../dict'`，确认 `dict/index.ts` 已导出 |
| 公开入口 import 报"没有导出成员" | 符号没加进 `index.ts` | 补 `export { X } from './x.service'` |
| 循环依赖告警 | A 调 B、B 又调 A | 下沉共享逻辑到 `common/`，或抽查询层 |
| 动态 `await import('../a/a.service')` 也被判红 | 检查器覆盖动态 import | 改成 `await import('../a')` |
| archive 里出现 `prisma.contract` 被判红 | 跨域直查绕过查询层 | 把查询移到 `server/src/query/archive-queries.ts`（或新增 `<域>-queries.ts`） |
| AI 只读子域 import 业务模块被判红 | 分析与预警不应触发业务逻辑 | 直接查询或在 ai 内取数；写路径只允许 `register` |

## 6. 不做的事
- **不拆包、不拆服务、不拆库**：本项目的模块化只做"代码边界 + 验证边界"。
  数据层耦合（跨域外键/事务/报表）与部署约束决定了拆服务/拆库不可行，理由见 `git log` 与架构讨论记录。
