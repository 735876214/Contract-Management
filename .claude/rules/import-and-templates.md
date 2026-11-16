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
- 采购/合同的**变量体系**（三套，互不相通）与其约定见同目录的
  [procurement-and-tender.md](procurement-and-tender.md)「三套变量体系」一节。

## 单据 Excel 模板（业务 2026-10-17，口径 2026-10-18 补齐）

- 五类单据模板是**上传的 `.xlsx`**（存 `ContractTemplate.fileUrl`，分类走字典 `doc_template_category`），
  **只接受 `.xlsx`**——`.xlsm` 的宏在 ExcelJS 写出时会丢失，静默丢宏不可接受。
- **`fileUrl` 落库的是 `StorageService` 相对键**（如 `2026-10/a.xlsx`），不是 `/api/files/...` 公开 URL。
  上传接口同时返回 `{ url, key, fileName, size }`，落库用 `key`；展示时前端用
  `toFileUrl()` 补一次前缀（`web/src/utils/templateFile.ts`）。后端读盘前用
  `normalizeDocTemplateFileKey()` 再归一一次，兼容历史 URL 与已写坏的双前缀——
  **别把公开 URL 直接存库**（`assertSafeStorageKey` 会当绝对路径拒绝，表现为「上传成功、生成 400」）。
- 占位符语法与合同/采购模板一致（`{{变量名}}`）；表格占位符（如 `{{结算明细表}}`）必须**整格独占**
  才会按行展开（插行、复制样式与行高、下方合并区域下移）；与文字混排时退化为单元格内多行文本。
