import { createContext, useContext } from 'react';

/**
 * 「当前标签」的作用域上下文（多页签导航的底座）。
 *
 * 为什么必须是**上下文**而不是 `useLocation()`：
 * 多页签会把访问过的页面**同时挂在 DOM 上**（非活动的用 `display: none` 藏起来），
 * 于是"列表标签"与"编辑器标签"（`/x` 与 `/x?editor=1`）会同时存在。
 * 若页面用 `useLocation()` 判断自己该渲染列表还是编辑器，**被缓存的列表实例也会看到
 * URL 上的 `?editor=…`**，从而一起变成编辑器 —— 这正是查询参数式编辑器页签的致命处。
 *
 * 因此每个标签对应的页面实例由它**自己的键**决定形态：`BasicLayout` 在渲染每个缓存项时
 * 外面包一层本 Provider，值来自该标签自身的 key/href，与"当前 URL 是什么"无关。
 */
export interface TabScope {
  /** 本标签的键：菜单页 = `pathname`；编辑器页 = `pathname?editor=<new|id>` */
  tabKey: string;
  /** 本标签对应的路由路径（不含 query） */
  path: string;
  /** 本标签的完整地址（点击标签 / 关闭编辑器后回列表都用它导航） */
  href: string;
  /** 编辑器标签时为 `editor` 参数值（`new` 或记录 id）；菜单页为 `null` */
  editorId: string | null;
}

const TabScopeContext = createContext<TabScope | null>(null);

export const TabScopeProvider = TabScopeContext.Provider;

/** 取当前标签作用域；不在多页签内（理论上不会）时返回 `null`，调用方按"菜单页"处理 */
export function useTabScope(): TabScope | null {
  return useContext(TabScopeContext);
}
