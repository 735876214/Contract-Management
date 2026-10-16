import { Suspense, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Layout, Dropdown, Space, Badge, Button, Avatar, Spin, Tooltip, Typography } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BellOutlined,
  UserOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate, useOutlet } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import ProjectSwitch from '@/components/ProjectSwitch';
import AppSider, { BreadcrumbNav } from '@/components/Sider';
import { STORAGE_KEYS, readLocal } from '@/components/Sider/utils/storage';
import { useMenuData } from '@/components/Sider/hooks/useMenuData';
import { findMenuChain } from '@/components/Sider/utils/menuHelper';
import { useResponsive } from '@/hooks/useResponsive';
import { notificationApi } from '@/api/modules';
import { useTabsStore } from '@/store/tabs';
import { cacheKeyOf, editorIdOf, tabKeyOf, HOME_TAB_KEY } from '@/utils/tabs';
import { TabScopeProvider, type TabScope } from './tabScope';
import TagsView from './TagsView';

const { Header, Content } = Layout;

/** 标签被激活时重测量的兜底：等一帧再派发，元素从 display:none 切回来后才测得到尺寸 */
function useRemindChartsOnActivate(activeToken: number) {
  useEffect(() => {
    if (!activeToken) return;
    const id = window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => window.cancelAnimationFrame(id);
  }, [activeToken]);
}

/**
 * 主布局（DESIGN.md §10.1：布局层响应式）
 *
 * - 左侧导航：`AppSider`——≥768px 固定侧栏，<768px 自动改为覆盖式抽屉
 * - 折叠状态：桌面端沿用本地持久化值；进入手机宽度自动收起（抽屉默认关闭），
 *   回到桌面时恢复进入前的桌面偏好
 * - 内容区：**多页签导航条 + 面包屑 + 路由出口**；窄屏边距 16 → 8
 * - Header：保留项目切换 / 消息提醒 / 用户菜单，窄屏精简（项目切换限宽、隐藏用户名文字）
 *
 * ## 多页签的页面状态缓存（keep-alive）
 *
 * React Router 6 **没有** keep-alive，这里用 `useOutlet()` + 元素缓存在布局层自建：
 *
 * 1. 当前路由的元素（`useOutlet()`）在**渲染期**写入 `Map<标签键, ReactElement>`；
 * 2. 按**标签顺序**渲染全部已缓存元素，非活动的包一层 `display: none`——
 *    React 按 keyed 位置复用 fiber，于是组件实例与 state（筛选条件、表格、图表、表单草稿）都留着；
 * 3. 缓存项的 `key` 是 `标签键#version`：**右键"刷新"递增 version 就相当于重挂载**（重新取数）；
 * 4. 每个缓存项外面包一层 `TabScopeProvider`，让页面知道自己属于**哪个**标签——
 *    被缓存的列表标签与编辑器标签会同时在 DOM 上，靠 URL 判断形态会把列表也变成编辑器
 *    （见 `tabScope.ts` 的注释）。
 *
 * ⚠️ 页面被藏起来时容器宽度是 0，`useContainerWidth()` 会把它当"未测量 → 按宽处理"，
 * 重新显示时 `ResizeObserver` 会再报一次真实宽度；ECharts 与 rc-table 靠本组件激活时
 * 派发的一次 `resize` 兜底（`useRemindChartsOnActivate`）。**改动这里务必真渲染核验**
 * 「台账大宽表 / 工作台两张图」隐藏再显示后的渲染。
 *
 * 断点唯一来源：`@/hooks/useResponsive`（勿用 window.innerWidth）。
 */
export default function BasicLayout() {
  const { isMobile } = useResponsive();
  // 初始值取侧栏持久化偏好（此前固定 false，使 Sider 的 localStorage 持久化形同虚设）
  const [collapsed, setCollapsed] = useState<boolean>(() => readLocal<boolean>(STORAGE_KEYS.collapsed, false));
  /** 进入手机宽度前的桌面折叠偏好，供回到桌面时恢复 */
  const desktopCollapsedRef = useRef(collapsed);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const { menu } = useMenuData();

  const tabs = useTabsStore((s) => s.tabs);
  const activeToken = useTabsStore((s) => s.activeToken);
  const syncRoute = useTabsStore((s) => s.syncRoute);

  /* ---------------- 多页签：登记 + 缓存 ---------------- */

  const tabKey = tabKeyOf(location.pathname, location.search);
  const editorId = editorIdOf(tabKey);
  /** 菜单里能找到的才建标签 —— 旧扁平路径的 `<Navigate>` 与未知路径自然被排除 */
  const menuLabel = useMemo(
    () => findMenuChain(menu, location.pathname)?.slice(-1)[0]?.label ?? '',
    [menu, location.pathname],
  );

  useEffect(() => {
    if (!menuLabel) return; // 菜单尚未加载完；加载完会再跑一次
    syncRoute({
      key: tabKey,
      path: location.pathname,
      href: tabKey,
      title: editorId ? `${menuLabel} · ${editorId === 'new' ? '新增' : '编辑'}` : menuLabel,
      closable: tabKey !== HOME_TAB_KEY,
    });
  }, [tabKey, menuLabel, editorId, location.pathname, syncRoute]);

  const outlet = useOutlet();
  /** 标签键 → 该标签对应的路由元素。渲染期写入是幂等的（同一路由永远是同一元素） */
  const cacheRef = useRef<Map<string, ReactElement>>(new Map());
  if (outlet && menuLabel) cacheRef.current.set(tabKey, outlet);

  // 标签被关掉/淘汰后同步释放缓存，避免长期使用后 Map 无限增长
  useEffect(() => {
    const alive = new Set(tabs.map((t) => t.key));
    for (const key of [...cacheRef.current.keys()]) {
      if (!alive.has(key)) cacheRef.current.delete(key);
    }
  }, [tabs]);

  /** 每个标签的作用域（缓存键 → scope）；`key` 上用缓存键，故刷新标签会连带重建 scope */
  const scopes = useMemo(() => {
    const map: Record<string, TabScope> = {};
    for (const t of tabs) {
      map[cacheKeyOf(t)] = { tabKey: t.key, path: t.path, href: t.href, editorId: editorIdOf(t.key) };
    }
    return map;
  }, [tabs]);

  useRemindChartsOnActivate(activeToken);

  useEffect(() => {
    notificationApi.unreadCount().then((res: any) => setUnread(res?.count || 0)).catch(() => undefined);
  }, [location.pathname]);

  // 断点变化时调整侧栏：手机 → 收起（抽屉关闭）；桌面 → 恢复进入前的偏好
  useEffect(() => {
    if (isMobile) {
      desktopCollapsedRef.current = collapsed;
      setCollapsed(true);
    } else {
      setCollapsed(desktopCollapsedRef.current);
    }
    // 仅在断点变化时执行；collapsed 故意不入依赖，避免用户手动折叠时被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* 左侧导航：窄屏自动切换为抽屉式（内部由 useResponsive 决定） */}
      <AppSider collapsed={collapsed} onCollapsedChange={setCollapsed} />
      <Layout>
        <Header
          className="cms-header"
          style={{
            padding: isMobile ? '0 8px' : '0 16px',
            // 深墨面：与侧栏同族，内容区奶油底——页面骨架即设计文档的「深墨 ↔ 奶油」节奏
            background: 'var(--cms-surface-dark)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Space size={isMobile ? 4 : 8}>
            <Button
              type="text"
              aria-label={collapsed ? '展开菜单' : '收起菜单'}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
            />
            <ProjectSwitch />
          </Space>
          <Space size={isMobile ? 8 : 16}>
            {/* ⚠️ Tooltip 必须放在 **Badge/Dropdown 的内侧**：这两者都会 clone 自己的 child 挂事件，
                若把它们套在 Tooltip 外面，事件会挂在 Tooltip 上而不落到按钮，点击将静默失效。 */}
            <Badge count={unread}>
              <Tooltip title="消息中心">
                <Button type="text" aria-label="消息中心" icon={<BellOutlined />} onClick={() => navigate('/message')} />
              </Tooltip>
            </Badge>
            <Dropdown
              menu={{
                items: [
                  { key: 'profile', icon: <UserOutlined />, label: user?.realName || user?.username },
                  { type: 'divider' },
                  { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
                ],
                onClick: ({ key }) => {
                  if (key === 'logout') {
                    // 标签属于"上一个账号"，先清掉再登出（顺手清掉其 localStorage）
                    useTabsStore.getState().reset();
                    logout();
                    navigate('/login');
                  }
                },
              }}
            >
              <Space style={{ cursor: 'pointer' }}>
                <Tooltip title={user?.realName || '账号'}>
                  <Avatar style={{ backgroundColor: 'var(--cms-primary)', color: 'var(--cms-on-primary)' }}>
                    {user?.realName?.[0] || 'U'}
                  </Avatar>
                </Tooltip>
                {/* 窄屏只留头像，名字放进下拉菜单（Header 精简，DESIGN.md §10.1） */}
                {!isMobile && <Typography.Text>{user?.realName}</Typography.Text>}
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ margin: isMobile ? 8 : 16 }}>
          <TagsView />
          <BreadcrumbNav />
          {tabs.map((t) => {
            const element = cacheRef.current.get(t.key);
            // 恢复自 localStorage 的标签**不预挂载**：只挂活动页，其余点开时才建实例。
            // 否则会在 0×0 的容器里初始化 ECharts / rc-table，量到的宽高全是 0。
            if (!element) return null;
            const cacheKey = cacheKeyOf(t);
            const active = t.key === tabKey;
            return (
              <TabScopeProvider key={cacheKey} value={scopes[cacheKey]}>
                <div className="cms-tab-pane" style={active ? undefined : { display: 'none' }}>
                  {/* 每个标签自己的 Suspense：某个标签在加载分包时不会把别的标签一起清空 */}
                  <Suspense fallback={<Spin size="large" style={{ display: 'block', margin: '80px auto' }} />}>
                    {element}
                  </Suspense>
                </div>
              </TabScopeProvider>
            );
          })}
        </Content>
      </Layout>
    </Layout>
  );
}
