# TODO.md · 剩余任务

> **本文件只列「未完成」任务**：完成一项就**直接删除条目**（不用 `[x]` 勾选、不写"已完成"段落，
> 否则文件只增不减）；历史以 `git log` / PR 为准。
> 改动前必读的约定与踩过的坑见 [CLAUDE.md](CLAUDE.md)（**唯一事实源**；历史经验已在其中固化）。
> **基准**：main 分支 2026-10-14（**不在此逐批枚举已完成项**——那会随每次提交过期，历史见 `git log`）。

图例：`需业务澄清` 未澄清前不要动手 · `需外部条件` 等基础设施/凭据 · `可直接开工` 纯工程项

> 分组依据是**阻塞条件**（而不是"优先级"）：标着"可直接开工"却全是阻塞项，会让人排错期。
> **例外**：「四域扩展」的评估与主链路口径已定（决策留痕见 `git log` 与
> [.claude/rules/document-relationships.md](.claude/rules/document-relationships.md)）；
> 内部按**先后**标注 —— 「待实施」→「按需」，不做优先级排序。
> 说明：**发票「查验」仅用于登记核对（把发票信息录入后标记为已查验），不做验真、不接第三方查验服务**，
> 故此项已按业务澄清从待办中移除。

## 需业务澄清（澄清前不要动手）

> 当前无。
> 「归档后是否允许补录发票/付款」已由业务 2026-10-18 确认：**允许**（归档只锁合同/收领单/
> 结算/总结算的写操作，发票/付款在归档检查中给 warning），已登记进
> [.claude/rules/product-decisions.md](.claude/rules/product-decisions.md)。

> 「两处新增保留弹窗」已由业务 2026-10-17 确认并登记进
> [.claude/rules/product-decisions.md](.claude/rules/product-decisions.md)「界面形态」一节。

## 需外部条件（基础设施 / 凭据 / 他人配合就绪即可做）

- **通知通道适配器**（企微/钉钉机器人 Webhook）：现状只有站内信
  （`notification.service.ts` 注释即写「邮件/短信/企微/钉钉接口预留」），`send()` 只做 DB insert。
  **阻塞原因**：需要机器人凭据与出网策略，且要业务定「哪些事件发到群里」。
  **同一份应用凭据下的姊妹项**：企微/钉钉**免登 SSO**（OAuth → 映射现有 `User` → 签发现有 JWT，
  **不新建平行账号体系**）——凭据就绪即可一并做，故不单列。
- **多副本部署前的三项必办**：① **共享文件存储**——附件只存本地盘（业务 2026-10-18 明确不引入对象存储），
  多副本前需另行确定共享方案（当前未定）② **进程内缓存不一致**——`DictService.cache` 24h TTL、
  `refreshCache()` 只清本实例，A 改字典 B 最长 24h 才可见（`SysParamService` 同理）
  ③ **编号竞态**——`contract.service.nextCode()` 读 `max(yearSeq)` 再 +1，两副本会取到同号（被唯一约束挡住报错）。
  **阻塞原因**：单实例下这三条都无影响，**只在确定要上多副本时才值得做**；届时前置还有共享 PG。

## 可直接开工（工程项，按性价比排序）

> 2026-10-18 代码审查待修（7 项，按严重度排序）；修完即删条目。

### 安全 / 权限

- **上传危险类型黑名单补全**：`server/src/common/utils/upload-rules.ts` 的
  `DANGEROUS_UPLOAD_EXTS` 漏了 `.xhtml` / `.xht` / `.shtml` / `.svgz` / `.mht` / `.mhtml`；
  公开静态服务会按 `application/xhtml+xml`、`image/svg+xml` 返回，可在应用源下执行脚本。
  **验收**：补全名单 + `uploadRules.spec.mts` 用例；真打上传 `.xhtml` 返回 400。
- **合同删除按项目隔离**：`contract.service.remove(id)` 与新增的下游计数查询都没有 `projectId`，
  控制器 `DELETE /contracts/:id` 也不传项目上下文 → 可按 ID 删除其他项目的合同
  （违反 CLAUDE.md §3 铁律 3）。**验收**：`remove(id, projectId)` + `@ProjectId()`；
  所有 where 带 `projectId`；跨项目删除返回 400/404，新增集成用例。

### 数据完整性

- **结算：有金额但 `settleQty` 为空的日报行不能静默丢**
  （`common/utils/settlement-from-daily.ts:162`：`qty>0` 才计算合价）。当前会少算金额且无 warning。
  **验收**：明确口径后实现——若金额可独立结算则保留金额；否则至少写入 `warnings` 并提示补数量；
  补纯函数用例。
- **归档覆盖补充协议链**（`contract.service.archive()` / `create()`）：
  归档主合同后仍可 `POST /contracts` 新建补充协议（只校验父合同存在/非补充/同项目，不查 `archivedAt`），
  合同链金额与履约口径可在归档后继续变化；归档补充协议也不锁主合同/收领单。
  **验收**：`create()` 校验父合同 `archivedAt`；`update()/draft*/publish/sign` 对补充协议查链根归档状态；
  归档主合同时锁定整条链；补集成用例。
- **归档检查遵循 `settlement.require_confirmed`**（`contract.service.ts:211` 固定查 `CONFIRMED`）：
  开关关闭时未确认日报也参与结算，但归档检查忽略它们 → 可在有未结算数据时归档。
  **验收**：`archiveCheck` 复用 `SysParamService` 的条件过滤；开关开/关各一条集成用例。

### 字典 / 筛选

- **物资分类启动同步不得覆盖手工维护**（`seed.ts:263` 的 `updateMany(notIn)` + 规范项 upsert）：
  重启会停用字典管理里新增的分类、回滚改名/颜色/排序/启停。
  **验收**：改为一次性同步（sysParam 标记）或只补缺失项、不覆盖既有字段、不按 notIn 批量停用；
  仅定向清理明确的旧编码。
- **资产台账筛选取交集**（`asset.service.ts:62`）：同时传 `sourceCode` 与 `direction` 时后者覆盖前者，
  返回与来源筛选不符的结果。**验收**：两者取交集（来源不在方向集合时返回空），补一条查询用例。

## 四域扩展（主体已实施，剩余按需）

> 单据关系与复用边界见 [.claude/rules/document-relationships.md](.claude/rules/document-relationships.md)：
> **采购订单/对账由外部系统承接**（本项目不建 `PurchaseOrder`/`Reconciliation`），主链路为
> `采购任务/招标定标 → 合同 → 收领单 → 总日报 → 结算单 → 付款/发票`。
> **招标域已实施**（迁移 `20261019000000_tender_bidder_and_evaluation`，约定见
> [.claude/rules/procurement-and-tender.md](.claude/rules/procurement-and-tender.md)）；
> **结算生成口径已按总日报落地**（2026-10-18），**合同履约进度/归档锁定/进出场汇总均已实施**
> （见 [.claude/rules/document-relationships.md](.claude/rules/document-relationships.md) §4–§7）；
> 下面为剩余按需项。

> 已定边界（不再立项）：**采购订单与对账由外部系统承接**；合同签订后直接发生收领单及后续流程，
> 本项目不造订单/对账中间单据。「采购清单 → 合同清单衔接」已做（无新表），与上述链路不冲突。

### 剩余 · 按需

- **合同履约节点/里程碑表** `ContractFulfillment`：履约派生进度与归档锁定已实施（2026-10-18），
  仅当业务需要「计划节点 + 逾期 + 违约」时再建表；不重复结算/付款/收货单据。
- 移动刚需页 H5 精简版（响应式 V1 视口层 + V2 容器层均已完成，规则见 [DESIGN.md](DESIGN.md) §10）。
- 可选：半结构化字段改 PG `jsonb`、招标立项前置状态、`DailyReport.exitDate`。

## 本文件的维护方式

1. **完成即删除**：任务做完直接从本文件删条目，不留 `[x]`、不追加"最近完成"章节。
2. **新增任务**：只写「未完成、可执行」的事项，附证据（文件/接口/命令）与**阻塞原因**；
   按阻塞条件分流到三档之一：`需业务澄清` / `需外部条件` / `可直接开工`。
3. **需要长期记住的约定与坑**：**不要写在本文件**——写进 [CLAUDE.md](CLAUDE.md)（改动前必读的硬约定）
   或 [docs/development.md](docs/development.md)（做法与命令）；本仓库已不再保留 `.workbuddy/memory/`
   之类的历史记忆目录（2026-10-14 清理，内容含已废弃的 SQLite/双 schema 指引）。
   同理，**本文件不写「现为 N 个 spec / N 项断言」这类会过期的数字**：活文档的计数由
   `server/test/docStats.spec.mts` 锁，历史报告标「当时快照」即可（见 [CLAUDE.md](CLAUDE.md) §8 末尾）。
4. 与 [CLAUDE.md](CLAUDE.md) 的「验收铁律」配合使用：改完必须过构建 + 单测 + 真打请求。
