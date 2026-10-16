# 导入与模板细则

> **何时加载**：改动导入（Excel/校验/异步任务）、合同模板与占位符、种子模板时。

## 导入：两阶段 + 心跳 + 幂等去重

- **两阶段**（`ImportRunnerService`）：先全量校验出计划，全通过才在事务内写入——**全成功或全失败**；
  >1000 行自动转异步任务（`ImportTaskService` 返回 taskId 供轮询）。
- **执行期心跳、崩溃可回收**：`execute()` 写 `lockedAt` 并随进度刷新；启动时与每 5 分钟巡检一次
  （`reapStaleTasks()`，纯判据 `isImportTaskStale()`），把超过 10 分钟无心跳的 PENDING/RUNNING 任务置为
  FAILED（提示重新导入）。
- **幂等去重**：同一份文件（`模块+文件名+行数+内容摘要` 的 sha1）在 PENDING/RUNNING 期间重复提交时
  复用既有任务；`submit()` 用 PG **事务级咨询锁**串行化同键提交（双击就是并发，"先查后建"会双开）。
  ⚠️ 去重命中后**绝不能再跑一次 execute**（两次并发写同一批数据 → 后者撞唯一约束，任务被误置 FAILED）。
- 锁定：`importTask.spec.mts` + `test-integration/import-two-phase.int.spec.ts`。
- **提交后的收尾动作放 `RunOptions.afterCommit`**（runner 提供，同步/异步两条路径都覆盖）：需要**读得到刚写入的数据**
  的连带刷新只能放这里（事务内读不到未提交行）——如发票导入后挂结算单并刷台账。它失败**只记日志**，
  不改变导入结果（数据已提交，别把导入标成失败）。

## 合同模板占位符

- **只认双花括号** `{{变量名}}`（表格占位符 `{{物料编码清单}}` / `{{合同清单}}` 同类），
  渲染是零依赖纯函数 `server/src/modules/template/template-render.ts` 的 `renderTemplate()`；
  **单花括号 `{变量名}` 与英文遗留 key 的支持已移除**——别再加回兼容分支（旧写法还会误伤富文本里的 CSS 花括号）。
- ⚠️ **种子模板有两处，别只改一处**：`prisma/templates/*.ts`（独立文件）**和 `prisma/seed.ts` 里内联的 3 份**
  （后者只在空库 + `npm run seed` 时创建，改动当时不可见）。两道防线：`templateRender.spec.mts` +
  `templatePlaceholderSyntax.spec.mts`（源码扫描 + 渲染无残留）。
- 改语法或改模板后，重跑 `npx ts-node prisma/templates/upsert-purchase-exec.ts`（已是真 upsert，会刷新内容）。
- 细节见 docs/06 §3。
