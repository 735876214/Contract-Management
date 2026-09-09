import { useCallback, useEffect, useMemo, useState } from 'react';
import { Layout } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import Logo from './Logo';
import SearchInput from './SearchInput';
import RecursiveMenu from './RecursiveMenu';
import MenuLoader from './MenuLoader';
import type { AppSiderProps, MenuItem } from './types';
import { useMenuSearch } from './hooks/useMenuSearch';
import { getOpenKeysByPath, getSelectedKeyByPath } from './utils/menuHelper';
import { STORAGE_KEYS, readLocal, writeLocal } from './utils/storage';
import './index.less';

const { Sider } = Layout;

/**
 * 左侧固定侧边导航栏（Sider）主组件
 *
 * - 宽度 220px ↔ 80px，深色主题 #001529，过渡 0.3s ease
 * - 路由跳转 / 选中高亮 / 父级自动展开
 * - 折叠：Logo 缩写、搜索框隐藏、SubMenu 全部收起，状态持久化 localStorage
 * - 搜索：实时过滤（防抖 300ms），结果平铺，点击跳转后清空并恢复完整菜单
 * - 菜单数据：MenuLoader 从 /api/menu 动态加载，失败兜底本地 MENU_CONFIG
 */
export default function AppSider({
  collapsed: controlledCollapsed,
  onCollapsedChange,
  defaultCollapsed,
  title = '供应链管理系统',
  shortTitle = 'SCM',
}: AppSiderProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // —— 折叠状态：受控 / 非受控 + localStorage 持久化（需求 5.1）——
  const [innerCollapsed, setInnerCollapsed] = useState<boolean>(
    () => defaultCollapsed ?? readLocal<boolean>(STORAGE_KEYS.collapsed, false),
  );
  const collapsed = controlledCollapsed ?? innerCollapsed;

  const setCollapsed = useCallback(
    (value: boolean) => {
      setInnerCollapsed(value);
      writeLocal(STORAGE_KEYS.collapsed, value);
      onCollapsedChange?.(value);
    },
    [onCollapsedChange],
  );

  // —— 菜单数据：MenuLoader 通过 onMenu 回调同步（供高亮/展开/搜索使用）——
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const handleMenu = useCallback((loaded: MenuItem[]) => setMenu(loaded), []);

  const { keyword, setKeyword, results, active, clear } = useMenuSearch(menu);

  // —— 选中与展开：路由变化自动高亮 + 展开父级（需求 5.1）——
  const selectedKeys = useMemo<string[]>(
    () => [getSelectedKeyByPath(menu, location.pathname) ?? ''].filter(Boolean),
    [menu, location.pathname],
  );
  const autoOpenKeys = useMemo<string[]>(() => getOpenKeysByPath(menu, location.pathname), [menu, location.pathname]);
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  useEffect(() => {
    if (collapsed) {
      // 折叠态：SubMenu 自动全部收起（需求 6.1）
      setOpenKeys([]);
      return;
    }
    setOpenKeys((prev) => (prev.length ? Array.from(new Set([...prev, ...autoOpenKeys])) : autoOpenKeys));
  }, [autoOpenKeys, collapsed]);

  const handleOpenChange = useCallback((keys: string[]) => setOpenKeys(keys), []);
  const handleNavigate = useCallback(
    (path: string) => {
      navigate(path);
      // 点击搜索结果跳转后清空搜索、恢复完整菜单（需求 5.2）
      clear();
    },
    [navigate, clear],
  );

  return (
    <Sider
      className={`app-sider${collapsed ? ' is-collapsed' : ''}`}
      theme="dark"
      width={220}
      collapsedWidth={80}
      collapsed={collapsed}
      trigger={null}
      data-title={title}
      data-short-title={shortTitle}
    >
      <Logo collapsed={collapsed} onClick={() => navigate('/dashboard')} />
      <div className="app-sider__scroll">
        <MenuLoader onMenu={handleMenu}>
          {(loadedMenu) => (
            <>
              {!collapsed && (
                <SearchInput
                  value={keyword}
                  onChange={setKeyword}
                  results={results}
                  active={active}
                  onSelect={(item) => handleNavigate(item.path)}
                />
              )}
              {/* 搜索时隐藏完整菜单，仅展示平铺结果；清空后恢复 */}
              {active ? null : (
                <RecursiveMenu
                  items={loadedMenu}
                  selectedKeys={selectedKeys}
                  openKeys={openKeys}
                  onOpenChange={handleOpenChange}
                  onNavigate={handleNavigate}
                />
              )}
            </>
          )}
        </MenuLoader>
      </div>
      <button
        type="button"
        className="app-sider__collapse-trigger"
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? '展开菜单' : '收起菜单'}
      >
        {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        <span className="app-sider__collapse-text">收起菜单</span>
      </button>
    </Sider>
  );
}

export { default as BreadcrumbNav } from './BreadcrumbNav';
export { renderIcon } from './utils/iconHelper';
export { MENU_CONFIG } from './menuConfig';
export type { AppSiderProps, MenuItem, BreadcrumbItem } from './types';
