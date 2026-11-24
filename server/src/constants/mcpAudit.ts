/**
 * **MCP 调用的审计标记（单一事实源）**。
 *
 * 问题（2026-11-24 审计）：外部 AI 经 `mcp/` 读写本系统时——
 *   - 读操作（`cms_query` / `cms_get` / `cms_whoami` / `cms_list_resources`）**一条日志都不写**；
 *   - 写操作（`cms_import`）虽然记了，但与人工点「导入」**完全无法区分**。
 * 于是「AI 查走/导走了什么、谁给的权限」事后答不出来。
 *
 * 解法：`mcp/` 在每次后端请求上带两个头，`OperationLogInterceptor` 认这两个头——
 * 认到就把该请求**无论方法**都记一条，并写进 `OperationLog.actorTool`（null = 人工）。
 *
 * 为什么头名放在这里而不是别处：
 * - `mcp/` 是**独立 Node 包**，不能 import `server/src`；两边只能靠字面量对齐。
 * - 所以这里定义唯一的字面量，并由 `server/test/mcpAudit.spec.mts` 反向校验
 *   `mcp/src/cms-client.ts` 里确实写着同样的字面量（防止有人只改一边，静默退化成无审计）。
 *
 * 零依赖（无 Nest / 无装饰器），可被 `.mts` 单测直接加载。
 */

/** 发起方标识头（值固定为 {@link MCP_ACTOR}） */
export const MCP_ACTOR_HEADER = 'x-cms-actor';
/** 具体工具名头（如 `cms_query`） */
export const MCP_TOOL_HEADER = 'x-cms-tool';
/** 发起方标识的取值 */
export const MCP_ACTOR = 'mcp';
/** `actorTool` 列的写入上限（与 schema.prisma 保持一致：TEXT，但按 64 归一，便于检索） */
export const ACTOR_TOOL_MAX = 64;
/** 头缺失或畸形时的落库值——**仍要非 null**，否则「这是 AI 干的」这条事实就丢了 */
export const ACTOR_TOOL_FALLBACK = 'unknown';

export interface McpAuditContext {
  /** 发起方（当前只有 `mcp`） */
  actor: string;
  /** 归一化后的工具名，写入 `OperationLog.actorTool` */
  tool: string;
}

/** 请求头取值（Header 值可能是 string / string[] / undefined） */
function headerValue(headers: Record<string, unknown>, name: string): string {
  const raw = headers?.[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 工具名归一：小写、只留 `[a-z0-9_-]`、截断到 {@link ACTOR_TOOL_MAX}。
 *
 * 归一而不是直接落库：这个头由**外部进程**填写，把任意字符串写进审计表等于给
 * 外部输入开一条注入通道（换行、超长、伪造成别的人工日志值）。
 */
export function normalizeActorTool(raw: string): string {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, ACTOR_TOOL_MAX);
  return cleaned || ACTOR_TOOL_FALLBACK;
}

/** 该请求是否由 MCP 发起；是则返回审计上下文，否则 null */
export function mcpAuditContext(headers: Record<string, unknown> = {}): McpAuditContext | null {
  const actor = headerValue(headers, MCP_ACTOR_HEADER).toLowerCase();
  if (actor !== MCP_ACTOR) return null;
  return { actor: MCP_ACTOR, tool: normalizeActorTool(headerValue(headers, MCP_TOOL_HEADER)) };
}
