/**
 * CORS 白名单（2026-11-28 收敛）。
 *
 * 原来的写法是 `enableCors({ origin: true, credentials: true })`：
 * 对**任意**来源回显 `Access-Control-Allow-Origin` 且带上凭据。
 * 本仓鉴权走 httpOnly Cookie（`credentials: true` 是必需的），两者组合等于把
 * 「任何站点都能带用户 Cookie 打我们的接口」交给 `SameSite=Lax` 一个人守——
 * Lax 只挡住了跨站 POST 的表单/脚本发起，挡不住「同站不同源」与各种边角情形。
 *
 * 现在：**默认不回 CORS 头**（同源部署本来就是常态——单容器镜像里 nginx 把 `/api` 反代到
 * 127.0.0.1:3000，前端与接口同源；开发环境 vite 也把 `/api` 代理到后端）。
 * 真要把前端放到别的源上，就在 `CORS_ORIGINS` 里显式列出来。
 *
 * 口径：
 * - `CORS_ORIGINS` 不配 / 空 → 一律不回 CORS 头（浏览器侧跨源请求被拦，服务端照常响应）；
 * - `CORS_ORIGINS=https://a.com,https://b.com` → 只认这几个源（精确匹配 origin，
 *   忽略大小写与尾部斜杠，**不做**子串/前缀匹配——`https://a.com.evil.io` 不算）；
 * - `CORS_ORIGINS=*` → 回显请求来源（= 旧行为），**仅限本地调试**，启动会打 WARN。
 *
 * 无 `Origin` 头的请求（同源 GET、curl、MCP 客户端）不属于 CORS 范畴，本来就不需要这些头。
 */

/** 单个 origin 归一：小写、去尾部斜杠、只保留 scheme://host[:port]（把 path 丢掉） */
export function normalizeOrigin(value: string | undefined): string {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v === '*') return '*';
  try {
    // URL 解析会把 path/query/trailing slash 都吃掉，并规范化默认端口
    return new URL(v).origin.toLowerCase();
  } catch {
    // 不是合法 URL（例如写成 'localhost:5173' 少了 scheme）：原样小写比较，
    // 宁可匹配不上，也不要「猜」出一个宽松规则
    return v.replace(/\/+$/, '').toLowerCase();
  }
}

/** `CORS_ORIGINS=a,b` → ['a', 'b']（去空项、归一化、去重） */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const o = normalizeOrigin(part);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

/**
 * 这个请求来源放不放行。
 * - 没有 Origin（同源/非浏览器）→ false：不需要回 CORS 头，也不必声称「放行」；
 * - 白名单里有 `*` → 放行；
 * - 否则按**归一化后的 origin 精确相等**匹配。
 */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  const o = normalizeOrigin(origin);
  if (!o) return false;
  if (allowed.includes('*')) return true;
  return allowed.includes(o);
}

export interface CorsEnvLike {
  CORS_ORIGINS?: string;
}

/**
 * 给 `app.enableCors()` 用的选项。origin 用函数而不是数组，是为了让
 * 「不配就完全不回 CORS 头」与「配了就精确回显命中的那个源」两件事都成立。
 */
export function buildCorsOptions(env: CorsEnvLike = process.env as CorsEnvLike) {
  const allowed = parseCorsOrigins(env.CORS_ORIGINS);
  return {
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      cb(null, isOriginAllowed(origin, allowed));
    },
    credentials: true,
    maxAge: 600,
  };
}

/** 启动日志用的人话描述（有配置就列出来，没配置就说明是同源部署） */
export function describeCorsPolicy(allowed: string[]): string {
  if (!allowed.length) return 'CORS：未配置 CORS_ORIGINS（同源部署，不向浏览器回 CORS 头）';
  if (allowed.includes('*')) return 'CORS：CORS_ORIGINS=* 会回显任意来源（仅限本地调试，勿用于生产）';
  return 'CORS：允许来源 ' + allowed.join(', ');
}
