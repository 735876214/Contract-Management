# 测试与验收细则

> **何时加载**：新增/修改测试、改金额判定/状态流转/导入、或不确定"跑哪套测试"时。

## 两套测试，别混用

- `server/test/*.spec.*`：纯函数 / 漂移锁，**无 DB、秒级**，随 `npm test`（含 CI 门禁）。
- `server/test-integration/*.int.spec.ts`：**真库**，`npm run test:int`（需 `DATABASE_URL` 指向库名含
  `test`/`int` 的库）。
- **改金额判定 / 状态流转 / 导入相关代码必须另跑 `test:int`**——纯函数单测证明不了"闸门是否真的接上了"。

## `.mts` spec 的约束（2026-10-17 第 1 条已解除）

`.mts` 由 **Node 原生类型擦除**加载（不经 ts-node）：

1. **相对运行时 `import` 必须带显式扩展名**（Node ESM 不做推断）。
   **2026-10-17 起已解除「零依赖叶子」限制**：tsconfig 开了 `allowImportingTsExtensions` +
   `rewriteRelativeImportExtensions`（配 `ts-node.experimentalResolver`），src 模块可以写
   `from './x.ts'`——nest build / ts-node 在 emit 时自动改写为 `.js`（产物无 `.ts` 残留），
   `.mts` 原生 loader 也直接认识 `.ts` 后缀。**仍禁止的是无扩展名相对 import**（`from './x'`），
   由 `mtsConstraints.spec.mts` 兜底，报错直接给出修法。范例接线：
   `procurementFlow.ts` import `./statuses.ts`、两份单据变量共享 `doc-var-shared.ts`。
2. **装饰器与 JSX 不被擦除**：`@Injectable()` 的服务、`.tsx` 组件**永远**进不了 `.mts`——想覆盖它们只能用
   `test-integration/`（ts-node）；引入打包器型测试框架（jest/vitest）已被本仓库明确否决。
3. 内联 enum / 带运行时的 namespace 同样不支持。

另：`node:20` 会直接报无法识别 `.mts`，故 **Node 需 ≥22.18**（本地 v24、CI 用 24）。
前端纯逻辑单测就放在 `server/test/*.spec.mts`（直接 import `web/src/**` 中**无 `@/` 别名**的模块；
web 模块内部相对 import 同样须带扩展名——若 vite 侧不支持 `.ts` 后缀，保持 web 侧零相对 import 纪律）。

## 活文档计数锁（新增 spec 必做）

- 新增/删除 spec 必须同步 `docs/development.md §5` 的清单与计数（`docStats.spec.mts` 会校验**清单列全**与
  CLAUDE.md / development.md 里的「N 个 spec」一致）；新增迁移要同步 CLAUDE.md §2 的迁移列表。
- **断言数不写进散文**（随用例增减，以 `npm test` 输出为准）。

## 本机验收操作要点

- 判成败看**退出码**（`nest build` 输出带 ANSI，`grep "error TS"` 会漏判；`cmd | head` 的 `$?` 是 head 的）。
- 前端改动必须**真渲染核验**（Edge headless + CDP）：完整手法与踩坑见 `docs/development.md` §5.2 与 §9。
- 改后端后必须 `docker compose -f docker-compose.dev.yml restart server`（watch 不感知宿主机文件变更）。
