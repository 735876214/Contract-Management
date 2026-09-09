import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MenuItem, SearchResultItem } from '../types';
import { searchMenu } from '../utils/menuHelper';

/** 搜索防抖时长（需求 6.2：300ms） */
const DEBOUNCE_MS = 300;

export interface MenuSearchState {
  /** 输入框实时值 */
  keyword: string;
  setKeyword: (value: string) => void;
  /** 防抖后的搜索结果（平铺） */
  results: SearchResultItem[];
  /** 是否有有效关键词 */
  active: boolean;
  /** 清空搜索 */
  clear: () => void;
}

/**
 * 菜单搜索 Hook（需求 5.2 / 6.2）
 * 实时过滤（防抖 300ms）→ 递归遍历匹配 label/key → 结果平铺展示。
 */
export function useMenuSearch(menu: MenuItem[]): MenuSearchState {
  const [keyword, setKeyword] = useState<string>('');
  const [debounced, setDebounced] = useState<string>('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const results = useMemo<SearchResultItem[]>(() => searchMenu(menu, debounced), [menu, debounced]);

  const clear = useCallback((): void => {
    setKeyword('');
    setDebounced('');
  }, []);

  return {
    keyword,
    setKeyword,
    results,
    active: keyword.trim().length > 0,
    clear,
  };
}
