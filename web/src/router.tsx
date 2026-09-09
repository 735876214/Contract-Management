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
import Materials from '@/pages/Materials';
import ContractMaterials from '@/pages/ContractMaterials';
import Settlements from '@/pages/Settlements';
import Payments from '@/pages/Payments';
import Invoices from '@/pages/Invoices';
import Ledger from '@/pages/Ledger';
import Repayments from '@/pages/Repayments';
import Finance from '@/pages/Finance';
import Assets from '@/pages/Assets';
import Messages from '@/pages/Messages';
import Reports from '@/pages/Reports';
import System from '@/pages/System';
import Clauses from '@/pages/Clauses';
import ContractDraft from '@/pages/ContractDraft';

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
      { path: 'materials', element: <Materials /> },
      { path: 'contract-materials', element: <ContractMaterials /> },
      { path: 'settlements', element: <Settlements /> },
      { path: 'payments', element: <Payments /> },
      { path: 'invoices', element: <Invoices /> },
      { path: 'ledger', element: <Ledger /> },
      { path: 'repayments', element: <Repayments /> },
      { path: 'finance', element: <Finance /> },
      { path: 'assets', element: <Assets /> },
      { path: 'messages', element: <Messages /> },
      { path: 'reports', element: <Reports /> },
      { path: 'system', element: <System /> },

      // —— Sider 新菜单规范路径（需求：八、路径映射表），与旧路径并行兼容 ——
      // 合同管理
      { path: 'contract/list', element: <Ledger /> },
      { path: 'contract/material', element: <ContractMaterials /> },
      { path: 'contract/draft', element: <ContractDraft /> },
      // 日报管理
      { path: 'daily/report', element: <DailyReports /> },
      { path: 'daily/asset', element: <Assets /> },
      // 结算及付款管理
      { path: 'settlement/order', element: <Settlements /> },
      { path: 'settlement/fund', element: <Finance /> },
      { path: 'settlement/ledger', element: <Settlements /> },
      { path: 'settlement/payment', element: <Payments /> },
      // 发票 / 还款 / 消息 / 报表
      { path: 'invoice', element: <Invoices /> },
      { path: 'repayment', element: <Repayments /> },
      { path: 'message', element: <Messages /> },
      { path: 'statistics', element: <Reports /> },
      // 基础信息管理
      { path: 'base/project', element: <Projects /> },
      { path: 'base/supplier', element: <Suppliers /> },
      { path: 'base/material', element: <Materials /> },
      { path: 'base/template', element: <Templates /> },
      { path: 'base/clause', element: <Clauses /> },
      // 系统管理
      { path: 'system/user', element: <System /> },
      { path: 'system/role', element: <System /> },
      { path: 'system/dept', element: <System /> },
      { path: 'system/params', element: <System /> },
      { path: 'system/dict', element: <Dict /> },
      { path: 'system/log', element: <System /> },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
];
