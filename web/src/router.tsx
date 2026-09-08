import { useEffect, useState } from 'react';
import { Navigate, RouteObject, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import BasicLayout from '@/layouts/BasicLayout';
import { useAuthStore } from '@/store/auth';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Dict from '@/pages/Dict';
import Projects from '@/pages/Projects';
import Suppliers from '@/pages/Suppliers';
import Contracts from '@/pages/Contracts';
import Templates from '@/pages/Templates';
import DailyReports from '@/pages/DailyReports';
import ContractItems from '@/pages/ContractItems';
import Materials from '@/pages/Materials';
import ContractMaterials from '@/pages/ContractMaterials';
import Settlements from '@/pages/Settlements';
import Payments from '@/pages/Payments';
import Invoices from '@/pages/Invoices';
import Ledger from '@/pages/Ledger';
import Repayments from '@/pages/Repayments';
import Messages from '@/pages/Messages';
import Reports from '@/pages/Reports';
import System from '@/pages/System';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const loadProfile = useAuthStore((s) => s.loadProfile);
  const location = useLocation();
  // 有 token 但内存中的用户信息为空（刷新页面 / 新标签页）时，先恢复会话再渲染，
  // 否则菜单按权限过滤后为空、项目切换与用户信息都会丢失。
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!token) return;
    if (user) {
      setReady(true);
      return;
    }
    let alive = true;
    loadProfile()
      .catch(() => undefined)
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [token, user, loadProfile]);

  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!ready) return <Spin size="large" fullscreen tip="正在恢复登录状态…" />;
  return <>{children}</>;
}

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <BasicLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'dict', element: <Dict /> },
      { path: 'projects', element: <Projects /> },
      { path: 'suppliers', element: <Suppliers /> },
      { path: 'contracts', element: <Contracts /> },
      { path: 'templates', element: <Templates /> },
      { path: 'daily', element: <DailyReports /> },
      { path: 'items', element: <ContractItems /> },
      { path: 'materials', element: <Materials /> },
      { path: 'contract-materials', element: <ContractMaterials /> },
      { path: 'settlements', element: <Settlements /> },
      { path: 'payments', element: <Payments /> },
      { path: 'invoices', element: <Invoices /> },
      { path: 'ledger', element: <Ledger /> },
      { path: 'repayments', element: <Repayments /> },
      { path: 'messages', element: <Messages /> },
      { path: 'reports', element: <Reports /> },
      { path: 'system', element: <System /> },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
];
