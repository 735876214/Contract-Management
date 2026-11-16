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
  /** 当前请求的项目 id；不在请求里（启动期/脚本/单测）返回 undefined */
  get projectId(): string | undefined {
    const pid = storage.getStore()?.projectId;
    return pid ? pid : undefined;
  },
};
