import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer, Layout } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import Logo from './Logo';
import SearchInput from './SearchInput';
import RecursiveMenu from './RecursiveMenu';
import MenuLoader from './MenuLoader';
import type { AppSiderProps, MenuItem } from './types';
import { useMenuSearch } from './hooks/useMenuSearch';
import { useResponsive } from '@/hooks/useResponsive';
import { getOpenKeysByPath, getSelectedKeyByPath } from './utils/menuHelper';
import { STORAGE_KEYS, readLocal, writeLocal } from './utils/storage';
import './index.less';

const { Sider } = Layout;

/** 侧栏宽度（展开态），抽屉模式复用同一宽度 */
const SIDER_WIDTH = 220;
/** 侧栏底色（与 index.less 的 @app-sider-bg 保持一致，抽屉 body 需显式设置） */
const SIDER_BG = 'var(--cms-surface-dark)';

/**
 * 左侧侧边导航栏（Sider）
 *
 * - **桌面/平板（≥768px）**：固定侧栏，宽度 220px ↔ 80px，深色主题 var(--cms-surface-dark)，折叠状态持久化 localStorage
 * - **手机（<768px）**：改为 `<Drawer placement="left">` 覆盖式侧栏（DESIGN.md §10.1），
 *   选中菜单后自动关闭；折叠按钮在抽屉模式下不渲染（用遮罩/选中关闭）
 * - 路由跳转 / 选中高亮 / 父级自动展开
 * - 搜索：实时过滤（防抖 300ms），结果平铺，点击跳转后清空并恢复完整菜单
 * - 菜单数据：MenuLoader 从 /api/menu 动态加载，失败兜底本地 MENU_CONFIG
 *
 * 断点唯一来源：`@/hooks/useResponsive`（勿在本组件内使用 window.innerWidth）。
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
  const { isMobile } = useResponsive();

  // —— 折叠状态：受控 / 非受控 + localStorage 持久化 ——
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

  // —— 选中与展开：路由变化自动高亮 + 展开父级 ——
  const selectedKeys = useMemo<string[]>(
    () => [getSelectedKeyByPath(menu, location.pathname) ?? ''].filter(Boolean),
    [menu, location.pathname],
  );
  const autoOpenKeys = useMemo<string[]>(() => getOpenKeysByPath(menu, location.pathname), [menu, location.pathname]);
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  useEffect(() => {
    // 抽屉/折叠态下 SubMenu 不应保持展开（抽屉每次打开都从收起态开始更清爽）
    if (collapsed || isMobile) {
      setOpenKeys([]);
      return;
    }
    setOpenKeys((prev) => (prev.length ? Array.from(new Set([...prev, ...autoOpenKeys])) : autoOpenKeys));
  }, [autoOpenKeys, collapsed, isMobile]);

  const handleOpenChange = useCallback((keys: string[]) => setOpenKeys(keys), []);
  const handleNavigate = useCallback(
    (path: string) => {
      navigate(path);
      // 点击搜索结果跳转后清空搜索、恢复完整菜单
      clear();
      // 抽屉模式：选中后自动关闭，避免遮挡内容（DESIGN.md §10.1）
      if (isMobile) setCollapsed(true);
    },
    [navigate, clear, isMobile, setCollapsed],
  );

  /** 侧栏内容（固定侧栏与抽屉共用；`viewCollapsed` 为视觉折叠态） */
  const navContent = (viewCollapsed: boolean) => (
    <>
      <Logo
        collapsed={viewCollapsed}
        onClick={() => {
          navigate('/dashboard');
          if (isMobile) setCollapsed(true);
        }}
      />
      <div className="app-sider__scroll">
        <MenuLoader onMenu={handleMenu}>
          {(loadedMenu) => (
            <>
              {!viewCollapsed && (
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
      {/* 抽屉模式不需要折叠按钮（用遮罩 / 选中菜单关闭） */}
      {!isMobile && (
        <button
          type="button"
          className="app-sider__collapse-trigger"
          onClick={() => setCollapsed(!viewCollapsed)}
          title={viewCollapsed ? '展开菜单' : '收起菜单'}
        >
          {viewCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          <span className="app-sider__collapse-text">收起菜单</span>
        </button>
      )}
    </>
  );

  // —— 手机：覆盖式抽屉 ——
  if (isMobile) {
    return (
      <Drawer
        placement="left"
        open={!collapsed}
        onClose={() => setCollapsed(true)}
        width={SIDER_WIDTH}
        closable={false}
        rootClassName="app-sider-drawer"
        styles={{ body: { padding: 0, background: SIDER_BG, display: 'flex', flexDirection: 'column' } }}
      >
        {/* 复用 .app-sider 样式作用域；is-drawer 覆盖 sticky / 100vh 等固定定位相关规则 */}
        <div className="app-sider is-drawer" data-title={title} data-short-title={shortTitle}>
          {navContent(false)}
        </div>
      </Drawer>
    );
  }

  // —— 桌面 / 平板：固定侧栏 ——
  return (
    <Sider
      className={`app-sider${collapsed ? ' is-collapsed' : ''}`}
      theme="dark"
      width={SIDER_WIDTH}
      collapsedWidth={80}
      collapsed={collapsed}
      trigger={null}
      data-title={title}
      data-short-title={shortTitle}
    >
      {navContent(collapsed)}
    </Sider>
  );
}

export { default as BreadcrumbNav } from './BreadcrumbNav';
export { renderIcon } from './utils/iconHelper';
export { MENU_CONFIG } from './menuConfig';
export type { AppSiderProps, MenuItem, BreadcrumbItem } from './types';
