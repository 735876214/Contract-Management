import { useEffect, useState } from 'react';
import { Layout, Dropdown, Space, Badge, Button, Avatar, Typography, theme } from 'antd';
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
import { notificationApi } from '@/api/modules';

const { Header, Content } = Layout;

/**
 * 主布局（需求：九、组件结构）
 * - 左侧固定侧边导航栏：components/Sider（菜单展示/搜索/折叠/动态加载）
 * - 内容区顶部：面包屑导航（根据当前路由自动生成层级）
 * - Header 保留项目切换 / 消息提醒 / 用户菜单
 */
export default function BasicLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  useEffect(() => {
    notificationApi.unreadCount().then((res: any) => setUnread(res?.count || 0)).catch(() => undefined);
  }, [location.pathname]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* 左侧固定侧边导航栏：折叠状态内部持久化 localStorage，onCollapsedChange 同步给 Header 按钮 */}
      <AppSider collapsed={collapsed} onCollapsedChange={setCollapsed} />
      <Layout>
        <Header
          style={{
            padding: '0 16px',
            background: colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <Space>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
            />
            <ProjectSwitch />
          </Space>
          <Space size={16}>
            <Badge count={unread}>
              <Button type="text" icon={<BellOutlined />} onClick={() => navigate('/message')} />
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
                <Avatar style={{ backgroundColor: '#1677ff' }}>{user?.realName?.[0] || 'U'}</Avatar>
                <Typography.Text>{user?.realName}</Typography.Text>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ margin: 16 }}>
          <BreadcrumbNav />
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
