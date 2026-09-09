import type { MenuItem, SearchResultItem } from '../types';

/**
 * 菜单工具函数（需求 5.2 / 5.3 / 5.4 / 11）
 * 纯函数集合：递归遍历、扁平化、路径匹配、权限过滤均不修改入参。
 */

/** 判断是否为叶子节点（无 children 或 children 为空） */
export function isLeaf(item: MenuItem): boolean {
  return !item.children || item.children.length === 0;
}

/** 节点在树中的深度链路（含自身），用于面包屑与搜索链路展示 */
function collectChain(items: MenuItem[], match: (item: MenuItem) => boolean, trail: MenuItem[]): MenuItem[] | null {
  for (const item of items) {
    const next = [...trail, item];
    if (match(item)) return next;
    if (!isLeaf(item)) {
      const hit = collectChain(item.children as MenuItem[], match, next);
      if (hit) return hit;
    }
  }
  return null;
}

/** 扁平化所有「有路由的叶子节点」（需求 5.2：搜索结果平铺，不保留层级） */
export function flattenMenu(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  const walk = (list: MenuItem[]): void => {
    for (const item of list) {
      if (isLeaf(item)) {
        if (item.path) out.push(item);
      } else {
        walk(item.children as MenuItem[]);
      }
    }
  };
  walk(items);
  return out;
}

/** 关键词模糊匹配（不区分大小写，匹配 label / key） */
function hitKeyword(item: MenuItem, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return false;
  return item.label.toLowerCase().includes(kw) || item.key.toLowerCase().includes(kw);
}

/** 搜索菜单：返回平铺结果，附带完整层级链路文案（如「合同管理 / 合同台账」） */
export function searchMenu(items: MenuItem[], keyword: string): SearchResultItem[] {
  if (!keyword.trim()) return [];
  const results: SearchResultItem[] = [];
  const walk = (list: MenuItem[], trail: string[]): void => {
    for (const item of list) {
      const nextTrail = [...trail, item.label];
      if (isLeaf(item)) {
        if (item.path && hitKeyword(item, keyword)) {
          results.push({
            key: item.key,
            label: item.label,
            icon: item.icon,
            path: item.path,
            chainLabel: nextTrail.join(' / '),
          });
        }
      } else {
        walk(item.children as MenuItem[], nextTrail);
      }
    }
  };
  walk(items, []);
  return results;
}

/** 根据当前路由查找完整层级链路（含自身）；支持精确匹配与前缀匹配 */
export function findMenuChain(items: MenuItem[], pathname: string): MenuItem[] | null {
  const exact = collectChain(items, (item) => !!item.path && item.path === pathname, []);
  if (exact) return exact;
  return collectChain(items, (item) => !!item.path && pathname.startsWith(`${item.path}/`), []);
}

/** 根据当前路由计算应展开的父级菜单 key（需求 5.1：路由变化时自动展开父级） */
export function getOpenKeysByPath(items: MenuItem[], pathname: string): string[] {
  const chain = findMenuChain(items, pathname);
  if (!chain || chain.length <= 1) return [];
  return chain.slice(0, -1).map((item) => item.key);
}

/** 根据当前路由计算选中菜单 key（叶子节点 key） */
export function getSelectedKeyByPath(items: MenuItem[], pathname: string): string | null {
  const chain = findMenuChain(items, pathname);
  if (!chain) return null;
  return chain[chain.length - 1].key;
}

/**
 * 权限过滤（需求 5.5 / 11）：
 * - 无 permission 字段：默认可见
 * - permission 校验不通过：隐藏
 * - 分组节点：递归过滤子级，子级全部被隐藏时该分组整体隐藏
 */
export function filterByPermission(items: MenuItem[], hasPermission: (code: string) => boolean): MenuItem[] {
  const walk = (list: MenuItem[]): MenuItem[] => {
    const out: MenuItem[] = [];
    for (const item of list) {
      if (item.permission && !hasPermission(item.permission)) continue;
      if (isLeaf(item)) {
        out.push(item);
      } else {
        const children = walk(item.children as MenuItem[]);
        if (children.length === 0) continue; // 子菜单全部无权限 → 整体隐藏
        out.push({ ...item, children });
      }
    }
    return out;
  };
  return walk(items);
}
