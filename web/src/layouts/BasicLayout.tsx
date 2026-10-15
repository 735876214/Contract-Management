import { Suspense, useEffect, useRef, useState } from 'react';
import { Layout, Dropdown, Space, Badge, Button, Avatar, Spin, Typography } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BellOutlined,
  UserOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import ProjectSwitch from '@/components/ProjectSwitch';
import AppSider, { BreadcrumbNav } from '@/components/Sider';
import { STORAGE_KEYS, readLocal } from '@/components/Sider/utils/storage';
import { useResponsive } from '@/hooks/useResponsive';
import { notificationApi } from '@/api/modules';

const { Header, Content } = Layout;

/**
 * 主布局（DESIGN.md §10.1：布局层响应式）
 *
 * - 左侧导航：`AppSider`——≥768px 固定侧栏，<768px 自动改为覆盖式抽屉
 * - 折叠状态：桌面端沿用本地持久化值；进入手机宽度自动收起（抽屉默认关闭），
 *   回到桌面时恢复进入前的桌面偏好
 * - 内容区：顶部面包屑 + 路由出口；窄屏边距 16 → 8
 * - Header：保留项目切换 / 消息提醒 / 用户菜单，窄屏精简（项目切换限宽、隐藏用户名文字）
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
            <Badge count={unread}>
              <Button type="text" aria-label="消息中心" icon={<BellOutlined />} onClick={() => navigate('/message')} />
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
                    logout();
                    navigate('/login');
                  }
                },
              }}
            >
              <Space style={{ cursor: 'pointer' }}>
                <Avatar style={{ backgroundColor: 'var(--cms-primary)', color: 'var(--cms-on-primary)' }}>
                  {user?.realName?.[0] || 'U'}
                </Avatar>
                {/* 窄屏只留头像，名字放进下拉菜单（Header 精简，DESIGN.md §10.1） */}
                {!isMobile && <Typography.Text>{user?.realName}</Typography.Text>}
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ margin: isMobile ? 8 : 16 }}>
          <BreadcrumbNav />
          {/* 路由懒加载（见 router.tsx）的兜底：只替换内容区，侧栏/Header 不闪烁。
              注意：`Spin` 的 `tip` 只在 nest/fullscreen 模式下生效，裸用会有 antd 控制台告警，
              故这里不加 tip（文案对加载兜底没有信息量）。 */}
          <Suspense fallback={<Spin size="large" style={{ display: 'block', margin: '80px auto' }} />}>
            <Outlet />
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  );
}
