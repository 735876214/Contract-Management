/**
 * CMS REST 客户端：封装登录、统一信封解包、项目头、二进制下载、multipart 上传。
 *
 * 所有对外接口真实走既有 `/api`（同一套 JWT + RBAC + 项目隔离），
 * MCP 服务端不直接连数据库、不复制任何业务规则。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import type { CmsConfig } from './config.js';

export interface ApiEnvelope<T = unknown> {
  code: number;
  data: T;
  message: string;
  /** 服务端下发的是毫秒时间戳（number），与 ResponseInterceptor 同类型 */
  timestamp?: number;
}

/**
 * **MCP 审计上下文**：当前正在执行的工具名（AsyncLocalStorage，异步安全）。
 *
 * 每个工具 handler 由 `runWithTool(name, …)` 包一层，本文件发出的**所有** /api 请求
 * 都会带上 `x-cms-actor: mcp` + `x-cms-tool: <name>`；后端 `OperationLogInterceptor`
 * 认这两个头后把该请求无论方法都记一条，写进 `OperationLog.actorTool`。
 *
 * 为什么需要它：MCP 的 8 个工具里 4 个是纯 GET 查询，而默认审计口径只记写方法与
 * GET 导出下载 —— 不带这个头，「AI 查走了什么」一条日志都不会留下。
 *
 * 头名字面量必须与 `server/src/constants/mcpAudit.ts` 一致（独立包，不能 import），
 * 由 `server/test/mcpAudit.spec.mts` 反向校验本文件里确实写着同样的字面量。
 */
const toolContext = new AsyncLocalStorage<string>();

export const MCP_ACTOR_HEADER = 'x-cms-actor';
export const MCP_TOOL_HEADER = 'x-cms-tool';
export const MCP_ACTOR = 'mcp';

/** 在审计上下文里执行 `fn`：期间发出的请求都标记为 `tool` 发起 */
export function runWithTool<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  return toolContext.run(tool, fn);
}

/** 当前工具名（不在工具上下文里时 undefined，例如进程启动期的自检请求） */
export function currentTool(): string | undefined {
  return toolContext.getStore();
}

function auditHeaders(): Record<string, string> {
  const tool = toolContext.getStore();
  if (!tool) return {};
  return { [MCP_ACTOR_HEADER]: MCP_ACTOR, [MCP_TOOL_HEADER]: tool };
}

export class CmsApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly path: string,
  ) {
    super(`[CMS ${code}] ${message} (${path})`);
    this.name = 'CmsApiError';
  }
}

/** 当前账号的权限范围（来自 `/auth/profile`） */
export interface UserScope {
  isSuperAdmin: boolean;
  permissions: string[];
}

export interface LoginResult {
  token: string;
  userInfo?: unknown;
  projects?: unknown;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  projectId?: string;
  /** 覆盖默认超时（下载大文件可调大） */
  timeoutMs?: number;
}

export class CmsClient {
  private token: string | undefined;
  private loginInFlight: Promise<string> | undefined;
  /** 权限范围缓存：与签发它的 token 绑定，重登后自动失效（避免角色改完还按旧权限过滤） */
  private scopeCache: { token: string; scope: UserScope } | undefined;

  constructor(private readonly config: CmsConfig) {
    this.token = config.token;
  }

  // ---- 鉴权 ----

  private async login(): Promise<string> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      const { username, password } = this.config;
      if (!username || !password) {
        throw new CmsApiError(1401, '未登录且未配置 CMS_USERNAME/CMS_PASSWORD 或 CMS_TOKEN', '/auth/login');
      }
      const res = await this.rawFetch('/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      const env = (await res.json()) as ApiEnvelope<LoginResult>;
      if (!env || typeof env.code !== 'number') {
        throw new CmsApiError(1500, '登录响应格式异常（缺少 code）', '/auth/login');
      }
      if (env.code !== 0 || !env.data?.token) {
        throw new CmsApiError(env.code || 1401, env.message || '登录失败', '/auth/login');
      }
      this.token = env.data.token;
      return this.token;
    })();
    try {
      return await this.loginInFlight;
    } finally {
      this.loginInFlight = undefined;
    }
  }

  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    return this.login();
  }

  /** 当前身份信息（含权限码与可访问项目），帮助外部 AI 自省可用范围 */
  async profile(): Promise<unknown> {
    return this.requestJson('/auth/profile', { method: 'GET' });
  }

  /**
   * 当前账号的权限范围（缓存到 token 变更为止）。
   *
   * 用途：工具级权限过滤——本 MCP 的每个工具在本地先判一次，让「这个账号能不能查合同」
   * 在**调用前**就说清楚，而不是等后端回 1403 让 AI 自己去猜原因。
   * 本地判断**不是**安全边界：后端每个接口都有自己的 `@RequirePermissions`。
   */
  async scope(): Promise<UserScope> {
    const token = await this.ensureToken();
    if (this.scopeCache && this.scopeCache.token === token) return this.scopeCache.scope;
    const raw = (await this.profile()) as any;
    const scope: UserScope = {
      isSuperAdmin: raw?.isSuperAdmin === true,
      permissions: Array.isArray(raw?.permissions)
        ? raw.permissions.filter((x: unknown): x is string => typeof x === 'string')
        : [],
    };
    this.scopeCache = { token, scope };
    return scope;
  }

  /**
   * 取一份口径提示词的正文（服务端 `GET /api/ai/prompts/:key`）。
   *
   * 正文的**单一事实源在服务端**（`ai-insight/prompt-catalog.ts` → 各 prompt 文件），
   * 本包不存副本——否则系统更新了口径，外部 AI 还在按旧口径出结论。
   */
  /** 取一份口径上下文文档（markdown 正文），服务端 `GET /api/ai/context/:key` */
  async contextDoc(key: string): Promise<{ key: string; uri: string; title: string; markdown: string }> {
    return this.requestJson(`/ai/context/${encodeURIComponent(key)}`, { method: 'GET' });
  }

  /**
   * 取某类字典的启用项（`GET /api/dict/options/:typeCode`）。
   *
   * 该接口后端**只要求登录**（前端下拉数据源），故这里不做工具级权限判定——
   * 本地判定比后端更严会挡住本来能读的人，正是我们要避免的那类误伤。
   */
  async dictOptions(typeCode: string): Promise<unknown[]> {
    const list = await this.requestJson<unknown[]>(`/dict/options/${encodeURIComponent(typeCode)}`, {
      method: 'GET',
    });
    return Array.isArray(list) ? list : [];
  }

  async promptText(key: string, args: Record<string, string | undefined> = {}): Promise<string> {
    const data = await this.requestJson<{ text: string }>(`/ai/prompts/${encodeURIComponent(key)}`, {
      method: 'GET',
      query: args as Record<string, unknown>,
    });
    return String(data?.text ?? '');
  }

  // ---- 基础请求 ----

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(`${this.config.baseUrl}/${path.replace(/^\/+/, '')}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
        else url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private headers(extra?: Record<string, string>, withAuth = true): Record<string, string> {
    // 审计头放在 extra 之前：业务头（项目上下文等）可覆盖同名键，但审计标记不该被覆盖
    const h: Record<string, string> = { Accept: 'application/json', ...extra, ...auditHeaders() };
    if (withAuth && this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private projectHeader(opts: RequestOptions): Record<string, string> {
    const pid = opts.projectId ?? this.config.projectId;
    return pid ? { 'x-project-id': pid } : {};
  }

  private async rawFetch(path: string, opts: RequestOptions & { noAuth?: boolean } = {}): Promise<Response> {
    const url = this.buildUrl(path, opts.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.config.timeoutMs);
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: this.headers(
        { ...this.projectHeader(opts), ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        !opts.noAuth,
      ),
      signal: controller.signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    try {
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  /** JSON 请求：自动注入 token、401/1401 时重登一次，成功返回解包后的 data */
  async requestJson<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const doFetch = async (): Promise<Response> => {
      await this.ensureToken();
      return this.rawFetch(path, opts);
    };
    let res = await doFetch();
    if (res.status === 401) {
      this.token = undefined;
      res = await doFetch();
    }
    const text = await res.text();
    let env: ApiEnvelope<T> | undefined;
    try {
      env = text ? (JSON.parse(text) as ApiEnvelope<T>) : undefined;
    } catch {
      throw new CmsApiError(res.status, `非 JSON 响应：${text.slice(0, 200)}`, path);
    }
    if (!env || typeof env.code !== 'number') {
      throw new CmsApiError(res.status || 1500, `响应格式异常：${text.slice(0, 200)}`, path);
    }
    if (env.code === 1401 && this.config.username && this.config.password) {
      // token 过期：清掉重登后再试一次
      this.token = undefined;
      const retry = await (async () => {
        await this.ensureToken();
        return this.rawFetch(path, opts);
      })();
      const retryText = await retry.text();
      const retryEnv = retryText ? (JSON.parse(retryText) as ApiEnvelope<T>) : undefined;
      if (!retryEnv) throw new CmsApiError(retry.status, '响应为空', path);
      if (retryEnv.code !== 0) throw new CmsApiError(retryEnv.code, retryEnv.message, path);
      return retryEnv.data;
    }
    if (env.code !== 0) throw new CmsApiError(env.code, env.message, path);
    return env.data;
  }

  /** 二进制下载（导出 Excel / 模板 / Word）：落盘到 exportDir，返回绝对路径与字节数 */
  async download(
    path: string,
    opts: RequestOptions & { filenameHint?: string } = {},
  ): Promise<{ filePath: string; bytes: number; filename: string }> {
    const doFetch = async (): Promise<Response> => {
      await this.ensureToken();
      return this.rawFetch(path, opts);
    };
    let res = await doFetch();
    if (res.status === 401) {
      this.token = undefined;
      res = await doFetch();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new CmsApiError(res.status, `下载失败：${text.slice(0, 200)}`, path);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const filename = pickFilename(res.headers.get('content-disposition'), opts.filenameHint ?? basename(path));
    await mkdir(this.config.exportDir, { recursive: true });
    const target = uniquePath(this.config.exportDir, filename);
    await writeFile(target, buf);
    return { filePath: target, bytes: buf.length, filename: basename(target) };
  }

  /** multipart 上传（导入 Excel）：字段名 file。返回导入结果 JSON（未包 data 的原始对象） */
  async upload(
    path: string,
    filePath: string,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
    const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
    const buf = await readFile(abs);
    const url = this.buildUrl(path, opts.query);
    const doFetch = async (): Promise<Response> => {
      await this.ensureToken();
      // 每次重试都新建 FormData（流式 body 不能复用）
      const form = new FormData();
      form.append('file', new Blob([buf]), basename(abs));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.config.timeoutMs);
      try {
        return await fetch(url, {
          method: 'POST',
          headers: this.headers(this.projectHeader(opts)),
          body: form,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    let res = await doFetch();
    if (res.status === 401) {
      this.token = undefined;
      res = await doFetch();
    }
    const text = await res.text();
    let env: ApiEnvelope;
    try {
      env = JSON.parse(text) as ApiEnvelope;
    } catch {
      throw new CmsApiError(res.status, `非 JSON 响应：${text.slice(0, 200)}`, path);
    }
    if (env.code !== 0) throw new CmsApiError(env.code, env.message, path);
    return env.data;
  }
}

/** 从 Content-Disposition 解析文件名（优先 filename*=UTF-8''，兼容 filename="..."） */
export function pickFilename(header: string | null, fallback: string): string {
  if (header) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (star?.[1]) {
      try {
        return sanitizeFilename(decodeURIComponent(star[1]));
      } catch {
        /* ignore */
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    if (plain?.[1]) return sanitizeFilename(plain[1]);
  }
  return sanitizeFilename(fallback);
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned || 'download';
}

/** 避免覆盖同名文件：已存在则追加 -1/-2 ... */
export function uniquePath(dir: string, filename: string): string {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = join(dir, filename);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}
