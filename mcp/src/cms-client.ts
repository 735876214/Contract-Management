/**
 * CMS REST 客户端：封装登录、统一信封解包、项目头、二进制下载、multipart 上传。
 *
 * 所有对外接口真实走既有 `/api`（同一套 JWT + RBAC + 项目隔离），
 * MCP 服务端不直接连数据库、不复制任何业务规则。
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import type { CmsConfig } from './config.js';

export interface ApiEnvelope<T = unknown> {
  code: number;
  data: T;
  message: string;
  timestamp?: string;
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
    const h: Record<string, string> = { Accept: 'application/json', ...extra };
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
