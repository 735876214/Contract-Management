/**
 * 运行时配置：全部来自环境变量（便于在 MCP 客户端配置里注入）。
 *
 * CMS_BASE_URL       后端基地址，含 /api 前缀，如 http://localhost:3000/api（必填）
 * CMS_USERNAME       登录用户名（与 CMS_PASSWORD 二选一：也可只给 CMS_TOKEN）
 * CMS_PASSWORD       登录密码
 * CMS_TOKEN          预签发 JWT（优先于用户名/密码；省一次登录往返）
 * CMS_PROJECT_ID     默认项目 id（可被工具参数的 projectId 覆盖）
 * CMS_EXPORT_DIR     导出/下载落盘目录，默认 <cwd>/exports
 * CMS_TIMEOUT_MS     单次请求超时，默认 30000
 */
import { resolve } from 'node:path';

export interface CmsConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  token?: string;
  projectId?: string;
  exportDir: string;
  timeoutMs: number;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

export function loadConfig(): CmsConfig {
  const rawBase = env('CMS_BASE_URL') ?? 'http://localhost:3000/api';
  // 去掉尾部斜杠，保证拼出 `${baseUrl}/auth/login` 而不是双斜杠
  const baseUrl = rawBase.replace(/\/+$/, '');

  const timeout = Number(env('CMS_TIMEOUT_MS') ?? '30000');
  const config: CmsConfig = {
    baseUrl,
    username: env('CMS_USERNAME'),
    password: env('CMS_PASSWORD'),
    token: env('CMS_TOKEN'),
    projectId: env('CMS_PROJECT_ID'),
    exportDir: resolve(env('CMS_EXPORT_DIR') ?? 'exports'),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
  };

  if (!config.token && !(config.username && config.password)) {
    // 不直接抛出：允许在只读场景下先启动，真正调用时才因 401 报出可读错误。
    console.error(
      '[cms-mcp] 警告：未配置 CMS_TOKEN，也未配置 CMS_USERNAME + CMS_PASSWORD，接口调用将返回 1401 未登录。',
    );
  }
  return config;
}
