import { useCallback, useEffect, useState } from 'react';
import http from '@/api/http';
import { useAuthStore } from '@/store/auth';
import type { MenuItem, MenuDataState } from '../types';
import { MENU_CONFIG } from '../menuConfig';
import { filterByPermission } from '../utils/menuHelper';
import {
  MENU_CACHE_TTL,
  STORAGE_KEYS,
  readSessionWithTTL,
  removeSession,
  writeSession,
} from '../utils/storage';

/**
 * 菜单数据获取 Hook（需求 5.5）
 *
 * 流程：sessionStorage 缓存（5 分钟内不重复请求）→ GET /api/menu → 权限过滤 → 渲染；
 * 接口失败：使用本地 MENU_CONFIG 兜底并标记 error；返回空数组交由 MenuLoader 显示占位。
 */
export function useMenuData(): MenuDataState {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);
  const [isFallback, setIsFallback] = useState<boolean>(false);
  const [tick, setTick] = useState<number>(0);

  const reload = useCallback((): void => {
    removeSession(STORAGE_KEYS.menuCache);
    removeSession(STORAGE_KEYS.menuCacheAt);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let alive = true;

    // 1) 命中 5 分钟内缓存：直接使用，不再请求
    const cached = readSessionWithTTL<MenuItem[]>(STORAGE_KEYS.menuCache, STORAGE_KEYS.menuCacheAt, MENU_CACHE_TTL);
    if (cached) {
      setMenu(filterByPermission(cached, hasPermission));
      setLoading(false);
      setError(false);
      setIsFallback(false);
      return () => {
        alive = false;
      };
    }

    // 2) 请求后端菜单
    setLoading(true);
    http
      .get<unknown, MenuItem[]>('/menu')
      .then((data) => {
        if (!alive) return;
        const list = Array.isArray(data) ? data : [];
        writeSession(STORAGE_KEYS.menuCache, list);
        writeSession(STORAGE_KEYS.menuCacheAt, Date.now());
        setMenu(filterByPermission(list, hasPermission));
        setError(false);
        setIsFallback(false);
      })
      .catch(() => {
        if (!alive) return;
        // 3) 接口失败：本地 MENU_CONFIG 兜底
        setMenu(filterByPermission(MENU_CONFIG, hasPermission));
        setError(true);
        setIsFallback(true);
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [hasPermission, tick]);

  return { menu, loading, error, isFallback, reload };
}
