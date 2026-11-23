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
  - **只读子域**（`ai/analytics` / `ai/anomaly` / `ai/analysis`）**不得依赖业务模块**；
  - **窗口事实统一走 `server/src/query/ai-fact-queries.ts`**：合同链、结算、付款、发票、
    项目范围、日报/采购计数由 `load*Facts()` 提供，口径（排除草稿结算、排除失败/退款付款、
    作废/红冲发票不计入）只在这一处维护。`field-resolver` / `report` / `dataset-collector` /
    `scm` 已接入；**不要再在 AI service 里手写这几张表的同一套 where**。
    数据集明细查询（工作簿逐行取数）仍留在 `dataset-collector` 内，因为它们字段各异、不复用。
  - `ai/register.service.ts` 是**刻意的写路径**（复用 `ContractService` / `SupplierService` 的编号唯一、
    名称拼接、字典校验），**允许**依赖业务模块公开入口，不要"优化"掉。

## 3.2 跨模块写表：只走 owner 模块的写入原语

`prisma.<模型>.create/update/updateMany/upsert/delete/deleteMany` **只能由拥有该表的模块调用**
（检查器规则 4，owner 由「谁写得最多」判定，`user` / `contractTemplate` / `contractMaterial` 三个语义归属钉死在 `MODEL_OWNER_OVERRIDES`）。

别的模块确实要改这张表时，照这个范式做：

```ts
// server/src/modules/<owner>/<语义>-writes.ts —— 无状态函数，把事务句柄当第一个参数
import type { Prisma } from '@prisma/client';
type Db = Prisma.TransactionClient;
export async function setXxxStatus(db: Db, id: string, status: string): Promise<void> {
  await db.xxx.update({ where: { id }, data: { status, version: { increment: 1 } } });
}
// 再从 owner 的 index.ts 导出：export { setXxxStatus } from './<语义>-writes';
```

- 语义留在 owner：哪些列可改、`version` 要不要自增，由拥有者决定；调用方只表达业务意图。
- **不要**注入对方的 Service（`AuthGuard` 与控制器会连带进来，容易成 DI 环）。
- 例外：`ai/register.service.ts` 是刻意的写路径（复用业务 Service），由检查器白名单放行。

## 3.3 门禁自证：改检测逻辑必须跑 `--self-test`

`node scripts/check-module-boundaries.mjs --self-test` 用合成样例证明**写点检测本身有效**
（单行 / 跨行 / 多行链式 / 非模型字段 / 读方法 六种形态）。规则 4 的「无跨模块写表」结论
完全依赖这条正则，**改动 `WRITE_RE` 必须让自证保持全绿**——2026-11-23 之前它是行内正则，
格式化把 `.deleteMany(...)` 折行后即静默漏检（真实案例：`procurement` 越过 `contract` 删表）。

## 4. 不允许模块环

检查器用 Tarjan SCC 检测模块级循环依赖（当前为 0），**依赖边只由静态 `import ... from` 构成**。出现环时的修法：

1. 把共享逻辑下沉到 `server/src/common/`（纯函数优先）；
2. 或把"聚合读取"改为查询层（read model），不要反向调用写模块；
3. 互引确实无法拆分时（A 静态依赖 B，B 又要借 A 的写入原语），B 侧用 `await import('../a')`
   运行期加载——它不成环，且检查器仍会校验它是否走公开入口。**静态** import 依旧会被判环。

## 5. 常见错误

| 现象 | 原因 | 修法 |
|---|---|---|
| `from '../dict/dict.service'` 被判越界 | 绕过公开入口 | 改成 `from '../dict'`，确认 `dict/index.ts` 已导出 |
| 公开入口 import 报"没有导出成员" | 符号没加进 `index.ts` | 补 `export { X } from './x.service'` |
| 循环依赖告警 | A 调 B、B 又调 A | 下沉共享逻辑到 `common/`，或抽查询层 |
| 动态 `await import('../a/a.service')` 也被判红 | 检查器覆盖动态 import | 改成 `await import('../a')` |
| archive 里出现 `prisma.contract` 被判红 | 跨域直查绕过查询层 | 把查询移到 `server/src/query/archive-queries.ts`（或新增 `<域>-queries.ts`） |
| AI 只读子域 import 业务模块被判红 | 分析与预警不应触发业务逻辑 | 直接查询或在 ai 内取数；写路径只允许 `register` |
| 「跨模块直写他人表：A 写了 xxx」 | `prisma.xxx.update()` 绕过了 owner 模块 | 让 owner 导出写入原语（见 §3.2），调用方改用 `from '../<owner>'` 的函数 |

## 6. 不做的事
- **不拆包、不拆服务、不拆库**：本项目的模块化只做"代码边界 + 验证边界"。
  数据层耦合（跨域外键/事务/报表）与部署约束决定了拆服务/拆库不可行，理由见 `git log` 与架构讨论记录。
