# P0 整改计划（统一响应信封 / Prisma 生命周期 / 输入校验层）

> 状态：**计划稿（未改动任何业务代码）**　编制日期：2026-11-21
> 依据：2026-11-21 代码质量评估报告（worktree `dsh-9fc05602-152a`）的 P0 项。
> 约束：本计划**不改 `schema.prisma`**，因此**不产生迁移**（铁律 1 不触发）。


## 决策记录（2026-11-21 用户拍板）

1. **P0-1 做到阶段 B**（存量 117 处全部收口）。
2. **timestamp 保持毫秒数**（不改成 ISO 字符串）。
3. **白名单门禁走紧口径**：显式标记 + 校验标记（不做 service 内部数据流分析——实测 51 个假阳性）。

## 实施进度

| 项 | 状态 | 证据 |
|---|---|---|
| P0-2 错误信封补 timestamp | ✅ 完成 | `server/src/common/utils/error-envelope.ts` + `test/apiEnvelope.spec.mts`(4 断言) |
| P0-3 PrismaService 生命周期 | ✅ 完成 | `server/src/prisma/prisma.service.ts` + `useExisting` + `enableShutdownHooks()` |
| P0-1 阶段 A 门禁骨架 | ✅ 完成 | `scripts/check-body-whitelist.mjs`（含 `--selftest` 负向用例）+ `body-whitelist.allow.txt` + CI 一步 + `test/bodyWhitelist.spec.mts` |
| 验收证据 | ✅ 已跑 | server build 0 · web build 0 · `npm test` 1047 断言全绿 · `npm run test:int` 148 断言/28 套件全绿 · 宿主直启后 SIGTERM 日志有 `Prisma 连接已释放（$disconnect）` · 401/404 响应均为四字段 |
| P0-1 阶段 B 收口 | 进行中 | 117 处 @Body() 中已标记 60 处（`typed=inline` 28 / `pickFields=CONST` 32），豁免 57 处待收口 |

### 标记协议（阶段 B 照这个写）

```ts
// @body: pickFields=CONTRACT_FIELDS    // 走 pickFields(白名单常量)
// @body: normalize=this.pick           // 走私有 normalize/pick（逐字段显式构造）
// @body: typed=inline                  // 参数自带非 any 的内联类型注解
// @body: array=CONTRACT_DRAFT_FIELDS   // 批量数组体，逐项过白名单
```

门禁会校验：标记存在 · 类型合法 · 引用的常量/方法在模块内真实存在 · `typed=inline` 的参数确实不是 `any` ·
豁免条数 ≤ `MAX_ALLOW`（只减不增）。

## 0. 范围与总原则

| 编号 | 问题 | 一句话 | 预估工时 |
|---|---|---|---|
| P0-1 | 输入无校验层，`ValidationPipe` 空转 | 90 个 `@Body()` 标 `any`，0 个 DTO | 阶段 A 1~2 人日；阶段 B 1~2 周（分模块） |
| P0-2 | 错误响应缺 `timestamp`，与铁律 2 不一致 | 成功 4 字段、失败 3 字段 | 0.5 人日 |
| P0-3 | `PrismaClient` 无生命周期管理 | 无 `$connect` / `$disconnect` / shutdown hook | 0.5 人日 |

**执行顺序：P0-2 → P0-3 → P0-1 阶段 A →（视排期）P0-1 阶段 B。**
理由：前两项改动面小、可在同一次验收里合并；P0-1 阶段 A 引入 CI 门禁，需要前两项先让 CI 稳定。

**统一原则**

1. 每项独立可回滚（一个 commit，可 `git revert`）。
2. 不给业务逻辑引入行为变更；只补「契约 / 生命周期 / 护栏」。
3. 新增 spec **必须同步 `docs/development.md` §5 的清单与计数**（`test/docStats.spec.mts` 会锁）。
4. 每项完工都必须过：`cd server && npm run build` + `cd server && npm test`；改到拦截器/过滤器需另跑 `npm run test:int`。

---

## P0-2　错误响应补齐统一信封

### 现状（源码依据）

- 成功：`server/src/common/interceptors/response.interceptor.ts:27,29` → `{ code, data, message, timestamp: Date.now() }`。
- 失败：`server/src/common/filters/all-exceptions.filter.ts:56-60` → `{ code, data: null, message }`，**无 `timestamp`**。
- 下游：`mcp/src/cms-client.ts:16` 把 `timestamp` 声明成 `string | undefined`，与服务端实际下发的 `number` 不符（今天不报错，仅因它是可选字段）。
- 前端 `web/src/api/http.ts:24-48` 只读 `code` / `message`，**不依赖 `timestamp`** → 补齐不破坏现有行为。

### 改动点

1. `server/src/common/filters/all-exceptions.filter.ts`
   - 抽出纯函数 `buildErrorEnvelope({ code, message })` → `{ code, data: null, message, timestamp: Date.now() }`，响应体与单测共用（不必启动 Nest 即可测）。
   - `response.status(status).json(buildErrorEnvelope(...))`，**HTTP 状态码保持不变**（前端 401 分支靠它，见 `http.ts:46`）。
2. `mcp/src/cms-client.ts:16`：`timestamp?: string` → `timestamp?: number`（对齐实际下发类型）。
3. 文档（建议）：在 `.claude/rules/backend-conventions.md` 的「统一返回」一节补一句「**错误分支同形，仅 `data` 恒为 `null`**」，避免下次再漂。

### 明确不做

- 不改 HTTP 状态码策略（「成功恒 200 + body.code 判成败」是全站既定口径，`ResponseInterceptor` 与前端拦截器都依赖它）。
- 不改 `x-raw-response` 跳过逻辑（`main.ts:32-35`），它只作用于成功分支。

### 验收

1. `npm run build` 退出码 0。
2. 新增 `server/test/apiEnvelope.spec.mts`：断言四字段、`data === null`、`timestamp` 为数字；**同步 `docs/development.md` §5 计数**。
3. `docker compose -f docker-compose.dev.yml restart server`（**不是 `up -d`**，watch 不感知宿主机变更）后真打一个必然失败的请求：
   `curl -s -H "Authorization: Bearer $T" -H "x-project-id: $P" localhost:3000/api/contracts/does-not-exist` → 期望四字段齐全。
4. `npm run test:int` 抽查无连带失败（无任何用例断言错误体只有 3 字段；已 `grep` 确认 `test/`、`test-integration/` 中 0 处引用 `timestamp`）。

---

## P0-3　`PrismaClient` 生命周期与优雅关闭

### 现状（源码依据）

- `server/src/prisma/prisma.module.ts:6-11`：`useFactory: () => new PrismaClient({ log: ['error','warn'] })`，无 `onModuleDestroy`，无 `$connect` 预热。
- `server/src/main.ts` 全文无 `enableShutdownHooks()`（grep 0 命中）。
- 后果：容器滚动更新 / `docker compose down` 时连接不主动释放（等 PG 侧超时回收）；首个请求承担建连成本。
- **必须保持的约束**：`PrismaClient` 这个**注入 token** 不能变 —— `main.ts:37,53`、`server/test-integration/helpers.ts:59` 用 `app.get(PrismaClient)`，57 个 service 的构造器按类型注入 `private prisma: PrismaClient`。

### 改动点

1. 新增 `server/src/prisma/prisma.service.ts`：

```ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() { super({ log: ['error', 'warn'] }); }   // 选项与现状一致
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
```

2. `server/src/prisma/prisma.module.ts`（保持 `@Global()`）：

```ts
providers: [PrismaService, { provide: PrismaClient, useExisting: PrismaService }],
exports: [PrismaService, PrismaClient],
```

   `useExisting` 让**同一个实例**挂在两个 token 上：`app.get(PrismaClient)` 与 `inject(PrismaClient)` 全部零改动。
3. `server/src/main.ts`
   - `listen` 之前加 `app.enableShutdownHooks();`（否则 SIGTERM 不会触发 `onModuleDestroy`）。
   - 顺手把 `:47` 的 `console.log` 换成 `Logger`（与 `AllExceptionsFilter` 一致）。
4. `server/prisma/seed.ts`、`server/prisma/templates/upsert-purchase-exec.ts` 等**独立进程脚本**，各自 `new PrismaClient()` 不受影响；建议另开一项补 `$disconnect()`（低优先）。

### 风险与对策

| 风险 | 对策 |
|---|---|
| 集成测试用 `createApplicationContext` 且从不 `close()` | 行为不变：只有 `app.close()` 才触发 `$disconnect`；本次不强制改造测试 |
| 有人误以为可以多实例 | `useExisting` 保证单例；`prisma.service.ts` 顶部注释写明「不要在别处再 new」 |
| 启动期 `$connect()` 失败会直接抛 | 这是期望行为（快速失败）；`main.ts` 里 `runStartupSeed` 在 `listen` 之后，顺序不动 |
| 生产首启时 `$connect` 与 `runStartupSeed` 抢连接 | 连接池默认余量足够；如遇告警，把 `$connect` 放到 `onModuleInit`（现状即如此），不要挪到模块加载期 |

### 验收

1. `cd server && npm run build` 退出码 0。
2. `npm run test:int`（26 个 spec）全绿 —— 这条最关键，57 个 service 的注入链全动到了。
3. `docker compose -f docker-compose.dev.yml restart server`，启动日志无重复建连告警。
4. `docker compose -f docker-compose.dev.yml stop server`，日志应干净退出、无未捕获异常。

---

## P0-1　输入校验层（分阶段，不要一把梭）

### 现状（量化依据）

- `server/src/main.ts:30` 注册了 `new ValidationPipe({ whitelist: true, transform: true })`。
- 但 `find server/src -name "*.dto.ts"` → **0 个**；`grep "from 'class-validator'"` → **1 处**（4 个装饰器）。**没有类元数据，`whitelist` 不生效。**
- `@Body()` 共 **117** 处，其中标注 `any` 的 **90** 处。前 6 名：

| controller | any / total |
|---|---|
| `procurement/procurement-task.controller.ts` | 11/11 |
| `finance/finance.controller.ts` | 9/9 |
| `material/material.controller.ts` | 6/6 |
| `contract/contract.controller.ts` | 6/10 |
| `template/template.controller.ts` | 5/6 |
| `settlement/settlement.controller.ts` | 5/6 |

- 现有防线：service 里 52 处 `pickFields()`（`server/src/common/pick-fields.ts`，已带 `MAX_FIELD_TEXT = 100000` 长度上限与「未识别字段」告警）。**防线是约定，不是机制**：漏一处即整行可写。

### 阶段 A（建议本次落地，1~2 人日）：让现状诚实 + 用机制替代记忆

1. `main.ts:28-30` 注释订正：写明「当前无 DTO 类，`whitelist` 不生效；写路径白名单由各 service 的 `pickFields()` 承担」。避免下一个人误判「校验已有」。
2. 新增 `scripts/check-body-whitelist.mjs`（沿用 `check-module-boundaries.mjs` 的零依赖风格）：
   - 扫 `server/src/**/*.controller.ts`，找出 `@Body() …: any` 对应的处理方法名；
   - 要求其调用的 service 方法内出现 `pickFields(`；否则视为「未收口」，**默认失败**；
   - `scripts/body-whitelist.allow.txt` 存放**存量豁免**（初始 90 条），新代码不得新增豁免 —— 与 ESLint `--max-warnings` 冻结存量同一思路。
3. `.github/workflows/build.yml:95-98` 同段落加一步 `node scripts/check-body-whitelist.mjs`。
4. 脚本 `--list` 输出即存量清单，不必手写文档。

> 阶段 A 的收益不是「修好了」，而是**让存量不再增长、且一眼可度量**。

### 阶段 B（1~2 周，按模块推进）：从写路径风险最高的 5 个 controller 收口

顺序：`procurement-task`(11) → `finance`(9) → `material`(6) → `contract`(6) → `settlement`(5) → 其余。

每个 controller 的固定动作：

1. 在对应 service 顶部定义 `const XXX_FIELDS = [...] as const`（参考 `milestone.service.ts:20` 的 `MILESTONE_FIELDS` 既有写法）。
2. 把 `pickFields()` 收敛到 **service 方法的唯一入口**；controller 继续 `@Body()`，但类型由 `any` 改为 `Record<string, unknown>`，让「任意对象」这个意图显式化。
3. 每个模块补 1 条集成用例：`POST`/`PUT` 带一个**不该被写**的字段（如 `projectId` / `version` / `createdAt`），断言库里值未变 —— 把「约定」变成「证据」。
4. 从 `body-whitelist.allow.txt` 删掉对应条目（存量只减不增，进度可量化）。

### 阶段 C（可选，另立项）：zod schema

只对**新代码**强制；`pickFields` 保留作为老模块过渡层。收益：字段类型 + 范围校验 + `docs/03-API接口清单.md` 可自动生成。**不建议**现在把 90 处换成 class-validator DTO：需逐条读业务规则，风险远大于收益。

### 明确不做

- 不做全量 DTO 改造（理由见上）。
- 不加 `forbidNonWhitelisted: true`（会让现有前端任何多余字段直接 400，属行为破坏）。

### 验收

1. `node scripts/check-body-whitelist.mjs` 返回 0；**负向用例必须验**：临时注释掉任一 service 的 `pickFields` 后脚本应返回 1（否则又是一个永远绿的空转门禁）。
2. `npm test` 全绿（新增 spec 同步 `docs/development.md` §5）。
3. 阶段 B 每完成一个模块：`npm run test:int` 对应用例通过 + 重启后端真打一次 `PUT`，确认多余字段被忽略且日志有 `[pickFields]` 告警。

---

## 1. 汇总验收清单（每项完工都跑一遍）

```bash
cd server && npm run build          # 看退出码，别 grep "error TS"
cd web    && npm run build
cd server && npm test               # 全绿；新增 spec 已同步 docs/development.md §5
cd server && npm run test:int       # P0-3 / 阶段 B 必跑
node scripts/check-module-boundaries.mjs
node scripts/check-import-integrity.mjs
docker compose -f docker-compose.dev.yml restart server   # watch 不感知宿主机变更
```

## 2. 交付与分支

三个 P0 各一个 commit（建议信息：`fix(api): 错误响应补齐 timestamp`、`refactor(prisma): PrismaService 生命周期`、`chore(ci): 请求体白名单门禁`），在任务分支上推送并走 PR，不直推 `main`（见 `.claude/rules/parallel-development.md`）。

## 3. 待决策项（需要拍板）

1. **P0-1 做到阶段 A 还是 B**？A ≈ 1~2 人日（诚实 + 门禁）；B ≈ 1~2 周（90 处全部收口）。
2. **`timestamp` 用毫秒数还是 ISO 字符串**？建议保持 `Date.now()`（number），同时把 `mcp` 的类型改对。
3. **`check-body-whitelist.mjs` 判定口径**：按「service 方法内出现 `pickFields`」（松、误报少）还是「必须显式声明 `FIELDS` 常量」（紧、更可靠）。建议后者，但存量豁免会多几十条。

## 4. 附：上一轮评估的一处自我修正

上一轮把「cookie 未设 `secure`」列为 P2 观察项，**该判断不准确**：`server/src/modules/auth/auth.controller.ts:85-86` 已按 `req.secure` / `x-forwarded-proto` 条件设置 `secure`。应改为「仅在反代未透传 `x-forwarded-proto` 时才会丢掉 `secure`」，属部署配置核对项，不是代码缺陷。
