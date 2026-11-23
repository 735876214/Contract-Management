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

## 2.5 目录分层：谁的语义放谁家（2026-11-23 架构评审 P2）

| 目录 | 放什么 | 例子 | 由谁守 |
|---|---|---|---|
| `server/src/modules/<模块>/` | 该模块的业务语义，**含口径纯函数**（跨模块经 `index.ts`） | `contract/pay-ratio.ts`、`ledger/ledger-derived.ts`、`cost/labor-receiving.ts` | 本文件规则 1 / 3（检查器） |
| `server/src/domain/` | 多模块共用、**不能**归任一模块的纯口径原语（零 DB、零装饰器） | `contract-chain.ts`（算式）、`settlement-period.ts`、`amount-guard.ts` | 文件头 `owner` + `constants/metrics.ts` 登记（`metricsRegistry.spec` 锁） |
| `server/src/query/` | 跨域**只读**取数 | `*-queries.ts`（见 §3.1） | 检查器（archive/dashboard 禁 `prisma.<模型>`） |
| `server/src/common/` | 基础设施：响应/异常/Excel/导入/日志/存储/权限装饰器/where 组合器/分页/掩码 | `list-where.ts`、`storage-keys.ts`、`import-task.ts` | **`common/utils/` 白名单制**（检查器规则 5，新增要登记） |

`domain/` 为什么存在——两条**源码约束**，不是口味问题：

1. **AI 只读子域**（`ai-insight/analytics` / `ai-insight/anomaly` / `ai-insight/analysis`）**不得依赖业务模块**（§3.1，检查器判红），
   但链金额、资产流向、履约、结算期这些口径它们都要用 → 纯函数必须待在一个**非模块**目录；
2. **互相需要**：`settlement-period`（contract ↔ settlement）、`amount-guard`（payment ↔ settlement）
   两侧都要用，归任一方都会造出模块级环（规则 3 判红）。

留在 `domain/` 的文件（共 6 个，每个文件头都写了 `owner` 和消费方）：

| 文件 | owner | 为什么不能进 owner 模块 |
|---|---|---|
| `contract-chain.ts` | contract | 算式被 AI 只读子域引用（约束 1） |
| `milestone.ts` | contract | `ai/analysis/scm-facts.ts` 引用（约束 1） |
| `contract-fulfillment.ts` | contract | `ai/analytics/dataset-collector.service.ts` 引用（约束 1） |
| `asset-flow.ts` | asset | 同上（约束 1） |
| `settlement-period.ts` | settlement | contract 与 settlement 互引（约束 2） |
| `amount-guard.ts` | finance | payment 与 settlement 互引（约束 2） |

需要读表的链 IO 不在这里，在 `server/src/query/contract-chain-queries.ts`——**口径归 owner，取数归 read model**。

**跨前后端的纯计算原语**不在 `server/src/` 里，而在仓库根的 `packages/calc`（`@cms/calc`，
`file:` 依赖）：它是计算引擎（金额/舍入/税率/时间/聚合），不承载业务口径，见 `packages/calc/README.md`。
## 2.6 AI 家族：`ai` / `ai-core` / `ai-insight` / `ai-fill`（2026-11-23 P4）

原来 `ai` 一个模块 71 个文件 / 17,884 行，检查器只能整体放行。按「谁能改它、谁被谁依赖」拆成四块：

| 模块 | 内容 | 依赖方向 |
|---|---|---|
| `ai` | Nest 装配 + 控制器路由（`ai.module.ts` / `ai.controller.ts`） | → 其余三者 |
| `ai-insight` | 只读分析与预警：`analytics/`（数据集/经营分析）、`anomaly/`、`analysis/`（SCM）、`intent/`、`report*`、`ai.service`、`field-resolver` | → `ai-core` |
| `ai-fill` | 登记 / 取价 / 履约：`register.service` 等 + `quote/` + `fulfillment/` | → `ai-core`（+ 业务模块，登记写路径复用 `ContractService`/`SupplierService`） |
| `ai-core` | 底座：LLM 客户端、配额、提示词、字段目录、单据文本解析、金额/时间/数据集元信息（**零业务依赖**） | 叶子 |

依赖是 DAG（检查器规则 3 锁死）：`ai → {ai-insight, ai-fill} → ai-core`，无环。

**四个目录 = 四个 Nest 模块**（2026-11-24：目录边界升级成 DI 边界）：`AiCoreModule`（导出
`AiQuota` / `AiSettingService`）· `AiInsightModule`（`imports: [AiCoreModule]`，**不含任何业务模块**）·
`AiFillModule`（`imports: [AiCoreModule, ContractModule, SupplierModule]`，写路径的例外摆在明面上）·
`AiModule`（只做装配 + 路由）。好处是「只读分析不得依赖业务模块」从**路径约定**变成**编译期约束**：
想在 insight 里注入 `ContractService` 会直接编译失败。

**两条特殊规则（都是实测踩出来的）**：

1. **`ai-core` 是「库型」目录**（检查器的 `LIBRARY_MODULES`）：它**没有** `index.ts` 门面，
   调用方按文件引用（`import { centsToYuan } from '../ai-core/common/money.ts'`）。
   原因：`ai-insight`/`ai-fill` 的规则层与类型要被 `.mts` spec 用 Node **原生类型擦除**加载，
   而 barrel 会**贪婪加载**它转出的全部模块——里面既有 `@Injectable()` 装饰器（擦不掉），
   也有用构造函数参数属性的类，两者都会让 `.mts` 直接 `SyntaxError`。
2. **AI 家族内跨模块引用写 `'../ai-insight/index.ts'`（显式带 `index.ts`）**：同一批纯函数链路
   在 Node ESM 下**不做目录解析**，`from '../ai-insight'` 会报 `ERR_UNSUPPORTED_DIR_IMPORT`。
   `module.ts`/`controller.ts` 这类不被 `.mts` 加载的文件也照此写，保持一种写法。
   （其它模块之间仍是 `from '../contract'` 的写法，它们不在 `.mts` 加载链上。）

只读子域规则相应改为按新路径生效：`ai-insight/analytics`、`ai-insight/anomaly`、`ai-insight/analysis`
**不得**依赖业务模块，但**允许**依赖 `ai-core`（自家纯函数底座，检查器的 `AI_FAMILY_MODULES`）。
写路径白名单是**按完整路径**的：只放行 `ai-fill/register.service.ts` 一处（见 `AI_WRITE_PATH_ALLOWLIST`）。
## 3. 聚合器是刻意存在的

`archive` / `ai` 的 fan-out 很大（`archive` 直接读 11 个域的表），这是"全库视角"的报表/分析层，
不是违规；但**仍须走公开入口**。检查器会打印 `fan-out > 5` 的聚合器清单，供审查时判断是否在扩散。

## 3.1 跨域读取统一走 `server/src/query/`

- `archive` 的 11 个域读取已收敛到 `server/src/query/archive-queries.ts`；
  `modules/archive/**` **不得出现 `prisma.<模型>`**，由检查器锁定。
- 同理，**工作台**是纯只读聚合器（读合同/结算/台账/付款/发票/总结算/付款手续/逾期应付/采购/履约 10 张表），
  它的全部跨域读取已收敛到 `server/src/query/dashboard-queries.ts`；
  `modules/dashboard/**` **不得出现 `prisma.<模型>`**，同样由检查器锁定
  （2026-11-23 收敛前是 37 处，口径改动要在工作台里再抄一遍 where，抄漏就是第二套口径）。
- **合同台账**的跨域读取（合同 / 合同清单 / 日报 / 结算 / 发票 / 付款 / 总结算 / 项目名）收敛到
  `server/src/query/ledger-queries.ts`。注意与上面两者**不同**：台账**拥有** `SettlementLedger`，
  自身表的读写仍留在 `ledger.service.ts`，所以**不能**用「不得出现 `prisma.<模型>`」去锁它
  （检查器目前也没有"只读他人表"的规则——读侧的 owner 判定不可靠，容易误报）。这条靠 review 守。
- 新的跨域只读查询按 `<域>-queries.ts` 放进 `server/src/query/`，通过 `server/src/query/index.ts` 导出；
  函数只读、不带事务、每个都显式带 `projectId`。
- AI 分两类：
  - **只读子域**（`ai-insight/analytics` / `ai-insight/anomaly` / `ai-insight/analysis`）**不得依赖业务模块**；
  - **窗口事实统一走 `server/src/query/ai-fact-queries.ts`**：合同链、结算、付款、发票、
    项目范围、日报/采购计数由 `load*Facts()` 提供，口径（排除草稿结算、排除失败/退款付款、
    作废/红冲发票不计入）只在这一处维护。`field-resolver` / `report` / `dataset-collector` /
    `scm` 已接入；**不要再在 AI service 里手写这几张表的同一套 where**。
    数据集明细查询（工作簿逐行取数）字段各异、不复用，但**取数本身**也收进了查询层
    `server/src/query/ai-dataset-queries.ts`（`loadAiDatasetBundle` / `loadAiProjectCoreGroups` /
    `loadAiScopedProjects`）；预警的行级取数在 `server/src/query/ai-anomaly-queries.ts`
    （`loadAnomalyRows` / `loadAnomalyChain*`）。**AI 只读子域不得出现 `prisma.<模型>`**
    （唯一例外是 AI 自己的表 `aiAnalyticsReport`，检查器 `AI_OWN_MODELS`）。
    **但口径片段不得内联**：`statusCode: { not: 'DRAFT' }`、`notIn: ['FAILED','REFUNDED']`、
    `in: ['CANCELLED','RED']` 这类手写等价 where 一律禁止（在 SQL 三值逻辑下还会静默漏掉 `NULL` 状态行），
    必须 import `notDraft` / `paidPaymentWhere()` / `countedInvoiceWhere()`。
    由检查器 `INLINE_PREDICATE_RULES` 锁定 `AI_READ_ONLY_DIRS`（2026-11-23 加，现状 0 违规）。
  - `ai-fill/register.service.ts` 是**刻意的写路径**（复用 `ContractService` / `SupplierService` 的编号唯一、
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
- 例外：`ai-fill/register.service.ts` 是刻意的写路径（复用业务 Service），由检查器白名单放行。

## 3.3 门禁自证：改检测逻辑必须跑 `--self-test`

`node scripts/check-module-boundaries.mjs --self-test` 用合成样例证明**写点检测本身有效**
（单行 / 跨行 / 多行链式 / 非模型字段 / 读方法 六种形态）。规则 4 的「无跨模块写表」结论
完全依赖这条正则，**改动 `WRITE_RE` 必须让自证保持全绿**——2026-11-23 之前它是行内正则，
格式化把 `.deleteMany(...)` 折行后即静默漏检（真实案例：`procurement` 越过 `contract` 删表）。

## 4. 不允许模块环

检查器用 Tarjan SCC 检测模块级循环依赖（当前为 0），**依赖边只由静态 `import ... from` 构成**。出现环时的修法：

1. 把共享逻辑下沉：**纯口径**放 `server/src/domain/`（零 DB、零装饰器），**跨域取数**放
   `server/src/query/`；`server/src/common/` 只收基础设施（`common/utils` 是白名单制，见 §2.5），
   **不要**再把业务语义塞进 `common/`（2026-11-23 P2 前它就装着 16 个口径文件）；
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
| 「common/utils 只放通用件（白名单制）」 | 往 `common/utils/` 加了业务语义文件 | 归 owner 模块（跨模块走 `index.ts`），或放 `server/src/domain/`（见 §2.5）；确属通用件再登记检查器的 `COMMON_UTILS_ALLOWLIST` |
| 口径纯函数该放 `modules/<owner>/` 还是 `domain/` | 放错会让 AI 只读子域越界、或造出模块环 | 先看消费方：被 `ai/analytics|anomaly|analysis` 引用、或两个模块互相都要用 → `domain/`；否则归 owner 模块（§2.5 有清单） |
| 「跨模块直写他人表：A 写了 xxx」 | `prisma.xxx.update()` 绕过了 owner 模块 | 让 owner 导出写入原语（见 §3.2），调用方改用 `from '../<owner>'` 的函数 |

## 6. 不做的事
- **不拆包、不拆服务、不拆库**：本项目的模块化只做"代码边界 + 验证边界"。
  数据层耦合（跨域外键/事务/报表）与部署约束决定了拆服务/拆库不可行，理由见 `git log` 与架构讨论记录。
