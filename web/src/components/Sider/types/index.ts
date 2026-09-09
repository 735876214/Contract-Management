import type { ReactNode } from 'react';

/** 菜单项（支持无限层级嵌套） */
export interface MenuItem {
  /** 唯一标识 */
  key: string;
  /** 显示名称 */
  label: string;
  /** 图标名称（后端返回字符串）或 React 节点（本地配置） */
  icon?: string | ReactNode;
  /** 路由路径（叶子节点必须有） */
  path?: string;
  /** 子菜单 */
  children?: MenuItem[];
  /** 权限标识（预留） */
  permission?: string;
}

/** 后端 /api/menu 原始响应结构 */
export interface MenuApiResponse {
  code: number;
  message: string;
  data: MenuItem[];
}

/** 面包屑项 */
export interface BreadcrumbItem {
  /** 显示文案 */
  label: string;
  /** 可点击跳转的路由（当前页可不传） */
  path?: string;
}

/** 搜索结果项（平铺，不保留层级） */
export interface SearchResultItem {
  key: string;
  label: string;
  icon?: string | ReactNode;
  path: string;
  /** 完整层级链路（如 合同管理 / 合同台账），搜索结果展示用 */
  chainLabel: string;
}

/** useMenuData 返回结构 */
export interface MenuDataState {
  /** 过滤权限后的菜单数据；接口失败时为本地兜底配置 */
  menu: MenuItem[];
  /** 是否加载中 */
  loading: boolean;
  /** 接口加载失败（已使用本地兜底） */
  error: boolean;
  /** 是否为本地兜底数据 */
  isFallback: boolean;
  /** 手动重试 */
  reload: () => void;
}

/** Logo 组件 Props */
export interface LogoProps {
  collapsed: boolean;
  onClick?: () => void;
}

/** 搜索框组件 Props */
export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** 搜索结果（平铺） */
  results: SearchResultItem[];
  /** 是否有搜索关键词 */
  active: boolean;
  onSelect: (item: SearchResultItem) => void;
}

/** 递归菜单组件 Props */
export interface RecursiveMenuProps {
  items: MenuItem[];
  selectedKeys: string[];
  openKeys: string[];
  onOpenChange: (keys: string[]) => void;
  onNavigate: (path: string) => void;
}

/** MenuLoader 组件 Props：render-prop，向外抛出加载完成的菜单数据 */
export interface MenuLoaderProps {
  children: (menu: MenuItem[]) => ReactNode;
  /** 菜单数据同步回调（供 Sider 主组件做高亮/展开/搜索） */
  onMenu?: (menu: MenuItem[]) => void;
}

/** 面包屑组件 Props */
export interface BreadcrumbNavProps {
  /** 首页文案与路径 */
  homeLabel?: string;
  homePath?: string;
}

/** AppSider 主组件 Props */
export interface AppSiderProps {
  /** 受控折叠状态（可选；不传则组件内部管理并持久化 localStorage） */
  collapsed?: boolean;
  /** 折叠状态变化回调（用于 Layout 同步头部按钮等） */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** 默认折叠状态（非受控模式） */
  defaultCollapsed?: boolean;
  /** Logo 标题 */
  title?: string;
  /** 折叠时的缩写标题 */
  shortTitle?: string;
}
