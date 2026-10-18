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

- **上传目录替换为对象存储**：落盘写入点原有 **3 处**（`file.controller.ts` 的 multer、`contract.service.sign()`
  的签章件、`import-task.service` 的导入错误报告），已统一收敛到 `common/services/storage.service.ts`
  （`StorageLike` + 本地实现；目录/命名/越权校验/URL 都收在这一层）。
  剩下的工作：实现 `S3StorageService`（MinIO/S3）、在 `common.module.ts` 换 provider 绑定，
  并把 `main.ts` 的静态服务 `useStaticAssets` 改为代理或 302 重定向；
  **阻塞原因**：无对象存储实例可供验收（写出来的 S3 分支无法真打）；顺带可加哈希校验与版本管理。
- **通知通道适配器**（企微/钉钉机器人 Webhook）：现状只有站内信
  （`notification.service.ts` 注释即写「邮件/短信/企微/钉钉接口预留」），`send()` 只做 DB insert。
  **阻塞原因**：需要机器人凭据与出网策略，且要业务定「哪些事件发到群里」。
  **同一份应用凭据下的姊妹项**：企微/钉钉**免登 SSO**（OAuth → 映射现有 `User` → 签发现有 JWT，
  **不新建平行账号体系**）——凭据就绪即可一并做，故不单列。
- **多副本部署前的三项必办**：① 文件本地磁盘
  （已由上面的"对象存储"条目覆盖）② **进程内缓存不一致**——`DictService.cache` 24h TTL、
  `refreshCache()` 只清本实例，A 改字典 B 最长 24h 才可见（`SysParamService` 同理）
  ③ **编号竞态**——`contract.service.nextCode()` 读 `max(yearSeq)` 再 +1，两副本会取到同号（被唯一约束挡住报错）。
  **阻塞原因**：单实例下这三条都无影响，**只在确定要上多副本时才值得做**；届时前置还有共享 PG 与共享存储。

## 可直接开工（工程项，按性价比排序）

> 当前为空。

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
