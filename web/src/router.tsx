import { Navigate, RouteObject, useLocation } from 'react-router-dom';
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
import Settlements from '@/pages/Settlements';
import Payments from '@/pages/Payments';
import Invoices from '@/pages/Invoices';
import Ledger from '@/pages/Ledger';
import Repayments from '@/pages/Repayments';
import Approvals from '@/pages/Approvals';
import Messages from '@/pages/Messages';
import Reports from '@/pages/Reports';
import System from '@/pages/System';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
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
      { path: 'settlements', element: <Settlements /> },
      { path: 'payments', element: <Payments /> },
      { path: 'invoices', element: <Invoices /> },
      { path: 'ledger', element: <Ledger /> },
      { path: 'repayments', element: <Repayments /> },
      { path: 'approvals', element: <Approvals /> },
      { path: 'messages', element: <Messages /> },
      { path: 'reports', element: <Reports /> },
      { path: 'system', element: <System /> },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
];
