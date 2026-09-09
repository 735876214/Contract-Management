import { useEffect, useState } from 'react';
import { Layout, Menu, Dropdown, Space, Badge, Button, Avatar, Typography, theme } from 'antd';
import {
  DashboardOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  ProfileOutlined,
  ProjectOutlined,
  ShopOutlined,
  FileTextOutlined,
  FileSearchOutlined,
  CalendarOutlined,
  UnorderedListOutlined,
  AccountBookOutlined,
  WalletOutlined,
  ReconciliationOutlined,
  TableOutlined,
  SafetyCertificateOutlined,
  DollarOutlined,
  BellOutlined,
  BarChartOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import ProjectSwitch from '@/components/ProjectSwitch';
import { notificationApi } from '@/api/modules';

const { Header, Sider, Content } = Layout;

const MENUS = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '工作台', perm: 'dashboard:view' },
  { key: '/projects', icon: <ProjectOutlined />, label: '项目管理', perm: 'project:view' },
  { key: '/suppliers', icon: <ShopOutlined />, label: '供应商库', perm: 'supplier:view' },
  { key: '/contracts', icon: <FileTextOutlined />, label: '合同管理', perm: 'contract:view' },
  { key: '/templates', icon: <FileSearchOutlined />, label: '合同模板', perm: 'template:view' },
  { key: '/daily', icon: <CalendarOutlined />, label: '日报管理', perm: 'daily:view' },
  { key: '/items', icon: <UnorderedListOutlined />, label: '合同清单', perm: 'item:view' },
  { key: '/materials', icon: <DatabaseOutlined />, label: '物资基础库', perm: 'material:view' },
  { key: '/contract-materials', icon: <ProfileOutlined />, label: '合同物资清单', perm: 'material:view' },
  { key: '/settlements', icon: <AccountBookOutlined />, label: '结算管理', perm: 'settlement:view' },
  { key: '/payments', icon: <WalletOutlined />, label: '付款管理', perm: 'payment:view' },
  { key: '/invoices', icon: <ReconciliationOutlined />, label: '发票管理', perm: 'invoice:view' },
  { key: '/ledger', icon: <TableOutlined />, label: '合同台账', perm: 'ledger:view' },
  { key: '/repayments', icon: <SafetyCertificateOutlined />, label: '还款协议', perm: 'repayment:view' },
  { key: '/finance', icon: <DollarOutlined />, label: '资金费用台账', perm: 'finance:view' },
  { key: '/messages', icon: <BellOutlined />, label: '消息中心', perm: '' },
  { key: '/reports', icon: <BarChartOutlined />, label: '统计报表', perm: 'dashboard:view' },
  { key: '/system', icon: <SettingOutlined />, label: '系统管理', perm: 'system:user' },
  { key: '/dict', icon: <AppstoreOutlined />, label: '字典管理', perm: 'dict:view' },
];

export default function BasicLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, hasPermission } = useAuthStore();
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  useEffect(() => {
    notificationApi.unreadCount().then((res: any) => setUnread(res?.count || 0)).catch(() => undefined);
  }, [location.pathname]);

  const menus = MENUS.filter((m) => !m.perm || hasPermission(m.perm));
  const selected = menus.find((m) => location.pathname.startsWith(m.key))?.key || '/dashboard';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} trigger={null} theme="light" width={208}>
        <div style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 16, color: '#1677ff' }}>
          {collapsed ? 'CMS' : '企业合同管理系统'}
        </div>
        <Menu mode="inline" selectedKeys={[selected]} items={menus} onClick={({ key }) => navigate(key)} />
      </Sider>
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
              <Button type="text" icon={<BellOutlined />} onClick={() => navigate('/messages')} />
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
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
