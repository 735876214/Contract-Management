# TODO.md · 剩余任务

> **本文件只列「未完成」任务**：完成一项就**直接删除条目**（不用 `[x]` 勾选、不写"已完成"段落，
> 否则文件只增不减）；历史以 `git log` / PR 为准。
> 改动前必读的约定与踩过的坑见 [CLAUDE.md](CLAUDE.md)（**唯一事实源**；历史经验已在其中固化）。
> **基准**：main 分支 2026-10-14（**不在此逐批枚举已完成项**——那会随每次提交过期，历史见 `git log`）。

图例：`需业务澄清` 未澄清前不要动手 · `需外部条件` 等基础设施/凭据 · `可直接开工` 纯工程项

> 分组依据是**阻塞条件**（而不是"优先级"）：标着"可直接开工"却全是阻塞项，会让人排错期。
> **例外**：「四域扩展」整块都**没有阻塞**（评估已定，见 [docs/05](docs/05-四域扩展可行性评估.md)），
> 故其内部按**先后**标注 —— 「待实施」→「按需」，不做优先级排序。
> 说明：**发票「查验」仅用于登记核对（把发票信息录入后标记为已查验），不做验真、不接第三方查验服务**，
> 故此项已按业务澄清从待办中移除。

## 需业务澄清（澄清前不要动手）

- **「新增进编辑器页签」两处有意保留弹窗（业务 2026-10-17 口径：新增必须进编辑界面）**：
  ① 基础配置类 6 个模块（字典 / 用户角色 / 合同模板 / 条款 / 单据模板 / 采购模板）**保留弹窗**
  （低频简单表单，业务确认保留；若后续要统一再改页签）；② 「新增补充协议」（ContractQuery 的
  SupplementDraft 向导弹窗 + 合同详情里的简易补充协议弹窗）是**向导型动作**（选类型→生成草稿→发布），
  暂保留弹窗，如业务要求统一改页签再动。

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
  **不新建平行账号体系**，见 [docs/05](docs/05-四域扩展可行性评估.md) §13 ②）——凭据就绪即可一并做，故不单列。
- **多副本部署前的三项必办**（[docs/05](docs/05-四域扩展可行性评估.md) §4）：① 文件本地磁盘
  （已由上面的"对象存储"条目覆盖）② **进程内缓存不一致**——`DictService.cache` 24h TTL、
  `refreshCache()` 只清本实例，A 改字典 B 最长 24h 才可见（`SysParamService` 同理）
  ③ **编号竞态**——`contract.service.nextCode()` 读 `max(yearSeq)` 再 +1，两副本会取到同号（被唯一约束挡住报错）。
  **阻塞原因**：单实例下这三条都无影响，**只在确定要上多副本时才值得做**；届时前置还有共享 PG 与共享存储。
- **定期备份与恢复演练**：README 与 docs **没有任何备份/恢复步骤**（`pg_dump` / `pg_restore` 0 命中），
  而 [docs/05](docs/05-四域扩展可行性评估.md) §2 的选型表自己就写着"DB 主从/备份：按需，**先落实定期备份**"。
  交付物：一份可执行步骤（compose 环境下 `pg_dump` → 留存 → `pg_restore` 到临时库）+ **本地实测一次恢复**
  （只写文档不演练等于没做）。**阻塞原因**：NAS 上的落地位置与保留策略待定（可在本地先做通）。
- **确认 CI 新 workflow 的首跑结果**：2026-10-14 改过 `.github/workflows/build.yml`（`test` job 新增
  postgres service、建影子库、`prisma migrate diff --exit-code` 门禁与 `npm run test:int`），
  但**本机无 `gh` CLI**、也无法本地解析 YAML 真跑一遍，只逐条验过里面的命令。需在 GitHub Actions 上
  看该 job 是否绿（步骤序：prisma generate → 建 `cms_shadow` → migrate diff → `npm test` →
  `npm run test:int` → server/web build）。**确认后删本条**。

## 可直接开工（工程项，按性价比排序）

- **解除 `.mts` 单测的「相对导入」限制**（低优先，**已评估完，按需再做**）：2026-10-15 专项调查后
  更正了本条原先的措辞——**TS 版本不是障碍**：锁文件里 typescript 已是 5.9.3，
  `allowImportingTsExtensions` 与 `rewriteRelativeImportExtensions` 都可用
  （原先写的「现 ^5.3.3」只看了声明下限）。
  真正的限制是 **Node 类型擦除不支持装饰器与 JSX**：服务与 `.tsx` 组件**永远**进不了 `.mts`，
  解除扩展名限制的收益**仅限纯逻辑模块**（如让 `procurementFlow.ts` 直接 import `./statuses` 而不是写裸字面量）。
  **代价**：改 `tsconfig`（影响 `nest build` 与 ts-node 侧的 `.ts` spec/seed/`test:int`，需逐个验证），
  并在相关相对 import 上补 `.ts` 扩展名。已落地的兜底：`test/mtsConstraints.spec.mts` 把「被 `.mts`
  引用的模块不得新增无扩展名相对 import」钉死，所以**不做也不会踩雷**。

## 四域扩展（评估已定，待实施）

> 依据 [docs/05-四域扩展可行性评估.md](docs/05-四域扩展可行性评估.md)。**招标域已实施**（迁移
> `20261019000000_tender_bidder_and_evaluation`，约定见 [.claude/rules/procurement-and-tender.md](.claude/rules/procurement-and-tender.md)）；
> 下面各条为待排期任务，尚未实施。

### 待实施 · 先设计后开发

- **单据关系设计（先做）**：采购任务 → 合同 → 采购订单 → 收货 → 对账 → 结算；明确与现有收领单/结算的复用边界。
- **采购下游**：`PurchaseOrder`(+Item) → 到货验收（**复用收领单**，加 `purchaseOrderId`）→ `Reconciliation`。
- **合同增强**：履约派生进度（零表）→（按需）`ContractFulfillment` → 归档锁定。

> 注：四域扩展的「采购下游」与已完成的「采购清单 → 合同清单衔接」是同一段链路的两端——
> 衔接已做（无新表），后续再做订单/对账（要新表）。

### 待实施 · 按需

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
