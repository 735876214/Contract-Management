const PREFIX = 'scm_sider_';

/** 存储键名统一管理，避免散落魔法字符串 */
export const STORAGE_KEYS = {
  /** 折叠状态（localStorage，持久化） */
  collapsed: `${PREFIX}collapsed`,
  /** 菜单缓存数据（sessionStorage，5 分钟 TTL）
   *  版本后缀：菜单结构发生变更（如新增采购管理分组、付款手续、单据模板、总结算单、
   *  资金费用拆分为保理/逾期两项）时递增，用于让旧缓存自然失效 */
  menuCache: `${PREFIX}menu_cache_v9`,
  /** 菜单缓存写入时间戳（sessionStorage） */
  menuCacheAt: `${PREFIX}menu_cache_at_v9`,
  /**
   * 多页签导航的标签列表（localStorage，持久化）。
   * ⚠️ **刻意不带版本后缀**：标签是用户自己的"打开过哪些页"，不随菜单结构变化而失效；
   * 菜单项被删掉时，反序列化后的标签点进去会走到重定向/404 → 用户自己关掉即可。
   * （与 `menuCache` 不同：那是接口数据缓存，过期/结构变了必须失效。）
   */
  tabs: `${PREFIX}tabs`,
} as const;

/** 菜单缓存有效期：5 分钟 */
export const MENU_CACHE_TTL = 5 * 60 * 1000;

/**
 * 清除菜单缓存（数据 + 时间戳）。
 * 退出登录时必须调用：否则同一标签页切换账号后，会读到上一账号的菜单树（权限泄露观感）。
 * 注意键名带版本后缀，故不直接写字符串——统一走 STORAGE_KEYS，避免版本升级后漏清。
 */
export function clearMenuCache(): void {
  removeSession(STORAGE_KEYS.menuCache);
  removeSession(STORAGE_KEYS.menuCacheAt);
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 读取 localStorage 中的 JSON 值，解析失败返回 fallback */
export function readLocal<T>(key: string, fallback: T): T {
  const parsed = safeParse<T>(localStorage.getItem(key));
  return parsed === null ? fallback : parsed;
}

/** 写入 localStorage（JSON 序列化） */
export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储不可用（隐私模式等）时静默降级 */
  }
}

/** 读取 sessionStorage 中的 JSON 值，解析失败返回 null */
export function readSession<T>(key: string): T | null {
  return safeParse<T>(sessionStorage.getItem(key));
}

/** 写入 sessionStorage（JSON 序列化） */
export function writeSession(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** 清除 sessionStorage 指定键 */
export function removeSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** 读取 sessionStorage 中带 TTL 的缓存；过期或缺失返回 null */
export function readSessionWithTTL<T>(key: string, atKey: string, ttl: number): T | null {
  const cachedAt = Number(readSession<number>(atKey) ?? 0);
  if (!cachedAt || Date.now() - cachedAt > ttl) return null;
  return readSession<T>(key);
}
