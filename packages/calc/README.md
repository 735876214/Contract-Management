# `@cms/calc` · 前后端共享计算引擎

金额/舍入/税率/时间/聚合原语的**单一事实源**。server 的业务代码、web 的页面、以及两边的
单测（含 `.mts` parity spec）都从这里取，不允许在任何一侧复制公式。

## 为什么它是个包（而不是 `server/src/common/calc`）

这段代码**不属于任何业务模块**，却被前后端同时消费。它原先住在 `server/src/common/calc`，于是：

- web 只能靠**相对路径**伸手进 server 源码（`../../../server/src/common/calc/money.ts`），
  Docker 镜像里要额外 `COPY` 一份、dev compose 要挂 `./server:/server:ro`、vite 要 `fs.allow` 放行；
- 它在 `server/src` 里，但既不是 `modules/` 的东西，也不该算 `common/` 的基础设施。

（2026-11-23 架构解耦 P3 抽包，三处 hack 均已删除，见 `docs/04-Docker镜像构建与优化.md` §2.2。）

## 消费方式

```ts
import { round2, calcPriceWithTax, monthKey } from '@cms/calc';      // 聚合入口（index.ts）
import { round2 } from '@cms/calc/money';                            // 按文件取，意图更清楚
```

server 与 web 的 `package.json` 各有一行 `"@cms/calc": "file:../packages/calc"`。
**不用 npm workspaces**：本仓 CI 是三个 job 各自 `npm ci`，compose 按目录挂载，提升到根会连带改动 deployments。

## 产物（`*.js` + `*.d.ts` 在包根，随仓库提交）

- 生成：`node build.mjs`（`--force` 强制重编；默认产物比源码新就跳过）；
- server/web 的 `prebuild` / `pretest` / `pretest:int` 会自动调用；
- **产物入库**的原因：消费方有 4 种（server 的 tsc、ts-node、Node 原生 `.mts`、vite/rollup），
  入口脚本 10+ 个，`pre` 钩子覆盖不全；一致性由 CI 的产物新鲜度检查兜底
  （`node packages/calc/build.mjs --force && git diff --exit-code packages/calc`）。
- 为什么扁平放包根而不是 `dist/`：server 的 tsc 用 node10 解析，**不读 `exports`**，
  只有 `packages/calc/money.d.ts` 这种位置才能被 `@cms/calc/money` 解析到。

## 改这里的纪律

1. 只放**纯函数**：零依赖、零 IO、零 Nest、零 Prisma；
2. 改完跑 `node build.mjs`（或直接跑 `server`/`web` 的测试，`pre` 钩子会重编）；
3. 前后端口径漂移由 `server/test/*Parity.spec.mts` 锁定，改公式必跑 `cd server && npm test`；
4. 新增文件要同时更新 `src/index.ts` 的再导出。
