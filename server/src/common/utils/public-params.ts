/**
 * 系统参数（`SysParam`）的**读取白名单**（2026-11-23 第 24 轮审计）。
 *
 * 背景：产品口径「密钥只写不读」（见 `.claude/rules/product-decisions.md` → AI 服务配置），
 * `ai.apiKey` 存在 `SysParam` 里。系统管理页（`system.service.params()`）早就在过滤它，
 * 但 `GET /auth/profile` 直接把 `sysParam.getAll()` 整个缓存回了前端 —— 任意登录用户
 * （含只读账号）`curl /api/auth/profile` 就能拿到可用的上游密钥，与上面那条口径直接冲突。
 *
 * 因此：**任何"把整张参数表批量交给前端"的路径都必须过这里**，不要在别处再写一份过滤。
 * 新增敏感参数时只需登记进 `SECRET_PARAM_KEYS`（系统参数页与 profile 会同时生效）。
 */
export const SECRET_PARAM_KEYS: ReadonlySet<string> = new Set(['ai.apiKey']);

/** 该参数是否敏感（敏感 = 只由专属页面读写，不进任何批量读取） */
export function isSecretParam(key: unknown): boolean {
  return SECRET_PARAM_KEYS.has(String(key ?? ''));
}

/**
 * 过滤掉敏感键，返回**新对象**（不改入参：入参可能是缓存本体，改它会污染进程内缓存）。
 */
export function pickPublicParams(all: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all ?? {})) {
    if (!SECRET_PARAM_KEYS.has(k)) out[k] = v;
  }
  return out;
}
