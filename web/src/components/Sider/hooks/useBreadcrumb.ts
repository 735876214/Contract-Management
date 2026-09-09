import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import type { BreadcrumbItem, MenuItem } from '../types';
import { findMenuChain } from '../utils/menuHelper';

/**
 * 面包屑数据生成 Hook（需求 5.3）
 *
 * - 数据来源：当前路由匹配菜单配置，生成层级路径
 * - 固定首页：首项固定为「工作台」，点击跳转 /dashboard
 * - 路由找不到对应菜单：显示「工作台 / 未知页面」（需求 11）
 */
export function useBreadcrumb(menu: MenuItem[], homeLabel = '工作台', homePath = '/dashboard'): BreadcrumbItem[] {
  const location = useLocation();

  return useMemo<BreadcrumbItem[]>(() => {
    const items: BreadcrumbItem[] = [{ label: homeLabel, path: homePath }];
    // 首页本身不再重复展示一层
    if (location.pathname === homePath) return items;

    const chain = findMenuChain(menu, location.pathname);
    if (!chain) {
      items.push({ label: '未知页面' });
      return items;
    }
    chain.forEach((node, index) => {
      const isLast = index === chain.length - 1;
      items.push({
        label: node.label,
        path: isLast ? undefined : node.path, // 当前页面不可点击
      });
    });
    return items;
  }, [menu, location.pathname, homeLabel, homePath]);
}
