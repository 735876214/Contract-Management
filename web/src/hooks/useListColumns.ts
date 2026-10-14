import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  browserColumnStorage,
  clearHiddenColumns,
  nextHiddenColumns,
  readHiddenColumns,
  writeHiddenColumns,
} from '@/utils/listColumns';

/**
 * 列表页「列显隐」偏好（**每浏览器**持久化在 localStorage，不落库）。
 *
 * 纯逻辑在 `@/utils/listColumns`（无 React/DOM，可被 `server/test/*.spec.mts` 单测），本文件只做 React 壳。
 * 与 `ledger.columns.config`（服务端共享配置）是**两套语义**：台账页继续用它自己的服务端列设置。
 *
 * 用法：`const cols = useListColumns({ configKey, allKeys, lockedKeys: ['op'] })`
 */
export interface UseListColumnsOptions {
  /** 存储键（不传 = 不启用列配置） */
  configKey?: string;
  /** 当前全部列标识（用于「至少保留一列」的判断） */
  allKeys: string[];
  /** 不可隐藏的列标识（如「操作」列） */
  lockedKeys?: string[];
}

export interface UseListColumnsResult {
  /** 被隐藏的列标识 */
  hiddenKeys: string[];
  isHidden: (key: string) => boolean;
  /**
   * 切换显隐。`hidden` 传**目标状态是否为「隐藏」**（不传 = 取反）。
   * ⚠️ 勾选框的 `checked` 语义是「**可见**」，两者相反——`Checkbox.onChange` 里必须传 `!e.target.checked`
   * （这里不替调用方取反，是为了让「显式设置」也说得清）。受保护列 / 会清空表格的操作为无效操作，状态不变。
   */
  toggle: (key: string, hidden?: boolean) => void;
  /** 恢复默认（全部可见） */
  reset: () => void;
  hiddenCount: number;
}

export function useListColumns({ configKey, allKeys, lockedKeys = [] }: UseListColumnsOptions): UseListColumnsResult {
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);

  // 首次挂载与 configKey 变化时从存储读取（configKey 为空则清空，避免串页）
  useEffect(() => {
    setHiddenKeys(readHiddenColumns(browserColumnStorage(), configKey ?? ''));
  }, [configKey]);

  // 列集合变化（如台账动态列）时剔除已不存在的列，避免隐藏集合无限膨胀
  const validKeys = useMemo(() => allKeys.filter((k) => k !== ''), [allKeys]);
  useEffect(() => {
    setHiddenKeys((prev) => {
      const kept = prev.filter((k) => validKeys.includes(k));
      if (kept.length === prev.length) return prev;
      writeHiddenColumns(browserColumnStorage(), configKey ?? '', kept);
      return kept;
    });
  }, [configKey, validKeys]);

  const isHidden = useCallback((key: string) => hiddenKeys.includes(key), [hiddenKeys]);

  const toggle = useCallback(
    (key: string, hidden?: boolean) => {
      setHiddenKeys((prev) => {
        const target = hidden === undefined ? !prev.includes(key) : hidden;
        const updated = nextHiddenColumns(prev, key, target, validKeys, lockedKeys);
        if (updated !== prev) writeHiddenColumns(browserColumnStorage(), configKey ?? '', updated);
        return updated;
      });
    },
    [configKey, lockedKeys, validKeys],
  );

  const reset = useCallback(() => {
    clearHiddenColumns(browserColumnStorage(), configKey ?? '');
    setHiddenKeys([]);
  }, [configKey]);

  return { hiddenKeys, isHidden, toggle, reset, hiddenCount: hiddenKeys.length };
}
