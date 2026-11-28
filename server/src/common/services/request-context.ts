import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求上下文（项目 / 用户）——**让 service 不必层层透传 projectId 也能守住项目隔离**。
 *
 * 背景（2026-10-20 第 3 轮审计）：守卫只校验"你能不能进这个项目"（`x-project-id` 与
 * `projectMember` 关系），**不校验 URL/body 里的业务 id 属于哪个项目**。于是
 * `GET /procurement-tasks/<别的项目的 id>` 这类「按 id 取行」的接口全部是跨项目 IDOR：
 * 只要拿到/猜到 id 就能读，能写，甚至能删。要一个个给 controller → service 加参数，
 * 涉及 30 多处的签名改动，遗漏一处就破一个口子。
 *
 * 做法：中间件在请求入口把 `projectId` 放进 AsyncLocalStorage，service 里任何按 id
 * 取行的查询都用 `requestContext.projectId` 补一个 `projectId` 过滤。这样：
 * - 新增接口只要走同一个 helper，就自动带上隔离，不依赖"记得传参"；
 * - 反例仍可取：`requestContext.get()` 为 undefined 时（启动期任务、脚本、单测）不追加
 *   过滤，保持与改造前一致的行为，不会把内部调用全部弄坏。
 *
 * 不用 Nest provider 注入：中间件在 `app.use()` 阶段就要用到它，走模块级单例最省事，
 * 也避免"两个不同实例各存一份 store"的低级错误。
 */
export interface RequestContext {
  /** 当前请求的项目（来自 `x-project-id` 或 `?projectId=`，缺失为 undefined） */
  projectId?: string;
  /**
   * 本次请求的链路 id（2026-11-24 引入）：响应头 `x-request-id` 与 `OperationLog.requestId` 同源。
   * 用途：用户报「刚才保存失败了」时，能凭这个 id 直接定位到那一条操作日志，
   * 而不是拿时间戳在几十万行日志里捞。
   */
  requestId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  /** 在给定上下文里执行（中间件用） */
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  /**
   * **当前是否处在 HTTP 请求里**（不管有没有项目头）。
   *
   * 用途：把项目隔离从「失败即放行」改成「失败即拒绝」（2026-11-22 第 24 轮审计）。
   * 中间件对**每个**请求都会 `run()`（缺项目头时 store 存在、projectId 为 undefined），
   * 而启动期 seed / 脚本 / 单测根本不会进 `run()`（store 为 undefined）。
   * 于是这条判定能精确区分两种"没有 projectId"：
   * - 请求内没有 → **异常客户端**（漏带头/伪造请求）→ 必须拒绝，不能静默放宽过滤；
   * - 请求外没有 → 内部任务（跨项目聚合、播种、单测）→ 保持原有行为。
   *
   * 反例（改造前的真实口子）：持 `contract:view` 的用户请求
   * `GET /api/contracts/<别项目 id>` 且**不带 `x-project-id`**，`projectWhere()` 会丢掉
   * projectId 过滤 → 跨项目读到整张合同详情。
   */
  inRequest(): boolean {
    return storage.getStore() !== undefined;
  },

  /** 当前请求的链路 id；不在请求里（启动期/脚本/单测）返回 undefined */
  get requestId(): string | undefined {
    const id = storage.getStore()?.requestId;
    return id ? id : undefined;
  },

  /** 当前请求的项目 id；不在请求里（启动期/脚本/单测）返回 undefined */
  get projectId(): string | undefined {
    const pid = storage.getStore()?.projectId;
    return pid ? pid : undefined;
  },
};
