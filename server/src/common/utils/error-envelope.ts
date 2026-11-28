/**
 * 错误响应信封（**零依赖**，可被 `.mts`/`.ts` 单测直接加载）。
 *
 * 背景（2026-11-21 质量评估 P0-2）：`CLAUDE.md` 铁律 2 与
 * `ResponseInterceptor` 约定的统一返回是 `{ code, data, message, timestamp }`，
 * 但 `AllExceptionsFilter` 只回了前三个字段——成功与失败的**响应形状不一致**。
 * 前端 `web/src/api/http.ts` 只读 `code` / `message`，所以线上没炸；
 * 但 `mcp/` 复用同一套 `/api`，外部接入方按文档解析会拿到 `undefined`。
 *
 * 这里把「错误分支的信封」抽成纯函数：过滤器与单测共用同一份实现，
 * 避免以后再次两处各写一份而漂移。
 */

export interface ErrorEnvelope {
  /** 业务码：1001=参数错 / 1401=未登录 / 1403=无权限 / 1404=不存在 / 1500=服务器错误 */
  code: number;
  /** 错误分支恒为 null（与成功分支的 data 同名字段对应） */
  data: null;
  /** 可直接展示给用户的文案（不得含表名/列名/SQL，见 prisma-error.ts） */
  message: string;
  /** 毫秒时间戳，与 `ResponseInterceptor` 的成功分支同类型（number，非 ISO 字符串） */
  timestamp: number;
  /**
   * 链路 id（2026-11-24）：与响应头 `x-request-id`、`OperationLog.requestId` 同源。
   * **只在有值时出现**——启动期/脚本/单测这类没有请求上下文的调用不带这个字段，
   * 免得把 undefined 塞进 JSON 变成一个噪音键。
   */
  requestId?: string;
}

export function buildErrorEnvelope(input: {
  code: number;
  message: string;
  /** 便于测试注入；默认取当前时间 */
  timestamp?: number;
  /** 链路 id；传空/不传则不出现在信封里 */
  requestId?: string;
}): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    code: input.code,
    data: null,
    message: input.message,
    timestamp: input.timestamp ?? Date.now(),
  };
  if (input.requestId) envelope.requestId = input.requestId;
  return envelope;
}
