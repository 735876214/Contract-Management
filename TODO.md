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

- **`dashboard/*` 接口是否加 `dashboard:view` 权限码**（2026-10-22 审计留档）：现状是
  「已登录 + 项目成员即可访问」，泄露面仅同项目看板数据；种子角色（含 STAFF）都带该码，
  但自定义角色可能没有，单方面加权限会误伤，**需产品先定口径**再改。

## 需外部条件（基础设施 / 凭据 / 他人配合就绪即可做）

- **AI 预警的生产召回率评测**：目前只有合成夹具评测（召回 100% / 误报 0），真实单据上的召回率
  需要真实数据 + 人工标注。工具链已就绪、**不需要改代码**：
  `npm run anomaly:export -- --project <id>` 导出 → 人工标注 `hit` → `npm run anomaly:score`
  （门槛不达标脚本退非 0）。标注纪律见 [docs/AI应用落地计划.md](docs/AI应用落地计划.md) §10，
  方法与命令见 [docs/AI应用评测报告-6-9-结算异常预警.md](docs/AI应用评测报告-6-9-结算异常预警.md) §6–§7.1。
  真实数据到位后，顺带按 [docs/development.md](docs/development.md) §5.2 复核预警面板
  **有数据时**的手机端排版（演示库样本为 0，目前只验证过空态；表结构已补 `scroll`）。
- **LLM 措辞质量人工评分**：网关一直没配密钥，目前只验证了模板降级链路；配好密钥后补一次人工打分
  （结论是否点名到单据、动作是否可执行、有没有编数字）。
- **HTTPS 部署**：NAS 反代 + 证书。当前 JWT 走 httpOnly Cookie，无 HTTPS 时既有安全面问题，
  也拿不到 `getUserMedia`（现场拍照）。见
  [docs/09-移动端可行性评估-375px实测.md](docs/09-移动端可行性评估-375px实测.md) §4 阶段 C。

## 可直接开工（工程项，按性价比排序）

> 2026-11-22 质量审计的落地情况：**类型安全（strict）、ESLint 门禁、大服务拆分**已由
> `2863841`（P0–P1 质量整改）在 main 上完成；`PR #32` 落地隔离 fail-closed / 稳定错误码 / 分页口径；
> `PR #31` 补的是它没覆盖的**口径单一实现**与**样板去重**（导出/导入/列表筛选、keyword 过滤、文件下载各收敛一处，
> 台账合规筛选改窄投影，lint 预算收到 0，int 覆盖 27 → 32）。下面只留**尚未做**的。

- **剩余模块的 DB 集成测试**：`finance` / `auth` / `asset` / `supplier` / `payment`（付款登记本身）
  仍无独立的 `test-integration/*.int.spec.ts`（`finance` 1.4k 行仍是零集成覆盖）。
  照 `procurement-publish.int.spec.ts` 的写法补，首行写 `// @domains: <模块目录名>`。
- **付款月份空串未被拦**（2026-11-23 补测时发现）：`assertYearMonth()` 对 `null/undefined/''` 统一放行
  （它同时服务「结算月份可空」的调用方），于是 `createRecord({ payMonth: '' })` 能落库。而台账/看板对
  `payMonth` 做**字符串精确匹配**——空串行永远不会被任何月份的统计命中，等于"保存成功、账上少一块"。
  修法：在 `payment.service` 的写入路径上对 `payMonth` 单独要求非空（别改共享助手，会波及结算月份）。
  证据：`server/test-integration/payment.int.spec.ts` 的 ③ 只覆盖了格式档位，空串档位待补。

- **CORS 收敛为白名单**：`server/src/main.ts` 是 `enableCors({ origin: true, credentials: true })`
  （反射任意来源 + 携带凭据）；与 cookie 鉴权组合时风险被 `SameSite=Lax` 限住，但仍应改为
  `CORS_ORIGINS` 环境变量白名单，与部署文档同源。
- **采购 6 个单据页面仍高度同构**：`web/src/pages/Procurement/{FrameworkExplanation,PreMeetingMinutes,Notice,
  Document,ResultReport,PriceCompare}.tsx` 各 720–990 行，跨文件 10 行以上的重复窗口 24–44 处/对。
  变量映射与下载 helper 已收口（`utils/projectVars.ts` / `utils/blobDownload.ts`），页面骨架仍应向
  `components/procurement/ModuleListPage` + `EditorTabPage` 继续收敛。

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
