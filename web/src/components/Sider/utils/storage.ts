const PREFIX = 'scm_sider_';

/** 存储键名统一管理，避免散落魔法字符串 */
export const STORAGE_KEYS = {
  /** 折叠状态（localStorage，持久化） */
  collapsed: `${PREFIX}collapsed`,
  /** 菜单缓存数据（sessionStorage，5 分钟 TTL） */
  menuCache: `${PREFIX}menu_cache`,
  /** 菜单缓存写入时间戳（sessionStorage） */
  menuCacheAt: `${PREFIX}menu_cache_at`,
} as const;

/** 菜单缓存有效期：5 分钟 */
export const MENU_CACHE_TTL = 5 * 60 * 1000;

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
