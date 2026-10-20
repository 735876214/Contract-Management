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

> 当前无。原两项已由业务 2026-10-18 确认**不再推进**（决策登记见
> [.claude/rules/product-decisions.md](.claude/rules/product-decisions.md)「系统能力边界」）：
> ① 企微/钉钉通知通道与免登 SSO（无凭据与出网条件，站内信满足现状）；② 多副本部署及其三项前置
> （共享文件存储 / 缓存一致性 / 编号竞态）——单实例部署是最终形态。

## 可直接开工（工程项，按性价比排序）

> 当前为空。

## 四域扩展（已收口，不再立项）

> 全部已实施完毕，**已完成事项不留在本文件**（见文首规则）。单据关系、复用边界与已定口径
> 见 [.claude/rules/document-relationships.md](.claude/rules/document-relationships.md) 与
> [.claude/rules/procurement-and-tender.md](.claude/rules/procurement-and-tender.md)，
> 历史以 `git log` 为准。当前**无遗留待办**；有新需求按上方三档新增。

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
