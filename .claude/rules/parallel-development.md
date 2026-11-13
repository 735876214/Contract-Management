# 并行开发与模块级验收（多任务同时改代码时必读）

> **何时加载**：同时开多个对话/多个模块审查；需要在一个工作区并行改多个模块；
> 或者你正被"别人的未提交改动把我的验收弄红"卡住时。

## 0. 为什么要有这套机制（来自真实事故）

| 事故 | 现场 | 本文件的哪一节解决 |
|---|---|---|
| 未提交代码污染别人的验收 | 某会话 `test:int` 出现 **42 个失败，全部来自另一处未提交的 `settlement.service.ts`** | §1 worktree 隔离 |
| 提交了引用未跟踪文件的代码 | 页面提交了 `import '@/hooks/usePermission'`，hook 未入库 → 干净检出必红 | §5 提交自洽检查 |
| 会话互相看到对方改动 | 只能靠人工判断"哪些不是我改的" | §1 + §6 分支提交 |
| 文件移动期瞬时 TS2307 | `Cannot find module './x'` / 相对层级错 | §5 |

**核心判断：worktree 解决"看不到别人的改动"，`check-import-integrity` 解决"自己的提交是完整的"。
两者缺一不可。**

## 1. 每任务一棵 worktree

```powershell
# 在主仓根目录（或在任意 worktree 里）执行
node scripts/new-task-worktree.mjs settlement-audit --port 3111
```

它会：从 `origin/main` 切出 `.worktrees/settlement-audit`（分支 `feat/settlement-audit`）→
建三只库 → 写该树的 `server/.env` → 装依赖 + `prisma generate`。

- **一个任务一棵树，不要在同一棵树里做两件事。**
- 树目录 `.worktrees/` 已 gitignore；主树的 `git status` 不会显示它。
- 脚本用**主工作树**路径定位，从任意树运行都把新树建在主仓下。
- 可选参数：`--branch`、`--base`、`--port`、`--link-web`（junction 复用主树 web 依赖）、`--no-fetch`。

## 2. 数据库与端口（每棵独立）

| 用途 | 库名 |
|---|---|
| 开发 | `cms_wt_<slug>` |
| 集成测试 | `cms_int_wt_<slug>` |
| 影子库（`migrate diff`） | `cms_shadow_wt_<slug>` |

- 宿主机连接串：`postgresql://cms:cms123456@localhost:15432/<库名>?schema=public&connection_limit=4&pool_timeout=20`
- **绝不把 `test:int` 指向 `cms` / `cms_int`**：`verify-module` 有库名守卫，非 `*_wt_*` 直接 exit 2。
- 端口：后端 `31xx`、前端 `51xx`（脚本默认 `port` 与 `port+2000`），建树前会预检占用。

## 3. 运行方式（宿主机，不走容器）

```powershell
docker compose -f docker-compose.dev.yml up -d postgres        # 只起共享数据库
cd .worktrees/<slug>/server; $env:PORT=3111; npm run start:dev
cd .worktrees/<slug>/web;    $env:VITE_PROXY_TARGET="http://localhost:3111"; npm run dev -- --port 5111
```

dev 容器挂的是主树的 `./server` / `./web`，**服务不了 worktree**，所以 worktree 一律宿主机跑。
宿主机 watch 能感知文件变更，**不需要** `docker compose restart server`（旧 dist 坑只属于容器命名卷）。

## 4. 验收：`node scripts/verify-module.mjs`

只证明"本树的改动是绿的"，**不替代合入 main 前的全局门**。

| 改动 | verify 会做什么 |
|---|---|
| 总是 | `check-import-integrity`（已入库文件） |
| `web/**` | 默认全量 `npm run build`；`--fast` 且改动全在 `web/src/pages/` → 临时 tsconfig 子集 tsc |
| `server/**` | `nest build` + **全量** `npm test`（关键词筛会漏 parity/docStats） |
| schema/迁移 | `migrate diff --exit-code`（本树影子库） |
| 金额/状态/导入/关联 | `migrate deploy` + 选中的 int spec（`--test-concurrency=4`） |

- **覆盖边界**：`nest build` / `tsc` 是整程序编译，没有真正的"只编这个模块"；
  verify 能做的是**把测试与数据库范围收窄**，不能把类型检查收窄（`--fast` 例外，且仅限 pages）。
- **不覆盖**：真实渲染、E2E 交互、CI 的迁移门禁之外的部署问题——这些仍按 `docs/development.md` §5.2/§9。
- 同树并发运行会串行（`.verify.lock`，stale 30 分钟接管）；跨树天然并行。
- `--isolate` 让本次运行用独立 schema（`verify_<runId>`），允许同树并行，代价是全量建表。

## 5. 提交自洽（**提交前必跑**）

```powershell
node scripts/check-import-integrity.mjs
```

- 只扫 **`git ls-files` 已入库**的 `.ts/.tsx/.mts`：目标不存在、或存在但未入库 → 报错。
- 为什么不能只靠 build：`tsc` / `vite` 会把**未跟踪文件**一起编进依赖图，
  所以"工作树 build 绿"证明不了"提交是完整的"。
- 典型触发：新建文件先写了 `import` 却忘了 `git add`；移动文件后旧路径没改。
- CI 的 `server` job 也会跑这一步（在 build 之前）。

## 6. 分支与提交纪律

- 任务在 `feat|fix|refactor|chore/<slug>` 分支上完成 → **推分支 + PR**；`main` 只经合并进入。
  （原来"完成后直接 push main"在并行时会 race：谁后推谁覆盖别人的基线。）
- 提交粒度 = 一个逻辑变更组；**不要把别的模块的改动 `git add -A` 卷进来**。
- 提交信息沿用仓库风格：英文前缀 + scope、中文 body（`-` bullet，含"验收：…"），
  尾部 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`。
- 推送只走 SSH：`git push git@github.com:735876214/Contract-Management.git <branch>`。

## 7. 已知冲突热点（合并前先 rebase）

`docStats.spec.mts` 锁的是**全局单值**，两条分支各加 spec/迁移时必然改同一行：

- `CLAUDE.md` §2（迁移计数与名单）、§4（常用命令里的 spec 数）
- `docs/development.md` §5 / §5.1（spec 清单表与计数）

解决原则：**合并后计数等于实际文件数**。`docs/development.md §5` 表按字母序插入新行；
计数行建议拆成"纯函数 spec / 集成 spec"两行，减少同行冲突。

镜像型锁（`frontendChainParity` / `routePermissionParity` / `statusCodes` / `containerQuery`）
**不要因为并行而放宽**——它们本就要求两侧同步改。

## 8. 集成测试写法约束（并发下才安全）

- **禁止"全库计数"断言**：一律按自己的 `projectId` 或唯一前缀计数。
  （`material-categories.int.spec.ts` 断言全局 10/67/2 是依赖种子稳定的特例，新 spec 不要模仿。）
- 每个用例自建唯一 `Project`（`uniq`），不删表；字典由 `runStartupSeed()` 的咨询锁串行播种。
- 需要"全库可见"的聚合用例必须独占库（= 每树一只 `cms_int_wt_*`）。

## 9. 清理与禁用项

```powershell
node scripts/remove-task-worktree.mjs <slug>          # 删树，保留库
node scripts/remove-task-worktree.mjs <slug> --yes    # 连库一起删（不可恢复）
```

- 清理脚本会**先解 junction 再删树**；删除 junction 只用 `rmdir`，绝不递归。
- **禁止在 worktree 里 `git clean -xdf`**：会穿透 junction 删掉主树的 `node_modules`。
- **不要用 `git stash` 在多会话间搬改动**：stash 栈是共享的，可能抽走/弹出别人的内容。

## 10. 常见问题

| 症状 | 处置 |
|---|---|
| `too many clients already` | 确认测试 URL 带 `connection_limit=4`，`--test-concurrency=4`；否则调低并发 |
| `migrate diff` 报影子库错误 | 用 `new-task-worktree` 重建（幂等），确保 `cms_shadow_wt_*` 存在 |
| prisma 模型类型缺失/旧字段 | 该树 `node_modules` 串了：删掉重装 + `npx prisma generate` |
| verify 说 `DATABASE_URL` 不合法 | 该树没有 `.env` 或指向了 `cms`/`cms_int`；重跑建树脚本补齐 |
| 合并后 `docStats` 红 | 按 §7：计数改成实际文件数 |
