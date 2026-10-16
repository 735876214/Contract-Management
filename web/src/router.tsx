import { lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, RouteObject, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import BasicLayout from '@/layouts/BasicLayout';
import RequirePermission from '@/components/RequirePermission';
import { routePermissionCodes } from '@/constants/routePermissions';
import { useAuthStore } from '@/store/auth';
import Login from '@/pages/Login';

/**
 * 路由懒加载：所有业务页面按需加载，首屏只加载登录页 + 布局。
 * `vite.config.ts` 的 manualChunks（react / antd / echarts）负责公共依赖分包。
 * 具名导出的页面（`Settlements.SettlementLedgerPage`、`System.*`）需在此转成 default。
 */
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Dict = lazy(() => import('@/pages/Dict'));
const Projects = lazy(() => import('@/pages/Projects'));
const Suppliers = lazy(() => import('@/pages/Suppliers'));
const Subcontractors = lazy(() => import('@/pages/Subcontractors'));
const Contracts = lazy(() => import('@/pages/Contracts'));
const Templates = lazy(() => import('@/pages/Templates'));
const DailyReports = lazy(() => import('@/pages/DailyReports'));
const ReceiptOrders = lazy(() => import('@/pages/ReceiptOrders'));
const Materials = lazy(() => import('@/pages/Materials'));
const ContractMaterials = lazy(() => import('@/pages/ContractMaterials'));
const Payments = lazy(() => import('@/pages/Payments'));
const PaymentProcedures = lazy(() => import('@/pages/PaymentProcedures'));
const DocTemplates = lazy(() => import('@/pages/DocTemplates'));
const FinalSettlements = lazy(() => import('@/pages/FinalSettlements'));
const Invoices = lazy(() => import('@/pages/Invoices'));
const Ledger = lazy(() => import('@/pages/Ledger'));
const Repayments = lazy(() => import('@/pages/Repayments'));
const Finance = lazy(() => import('@/pages/Finance'));
const Assets = lazy(() => import('@/pages/Assets'));
const Messages = lazy(() => import('@/pages/Messages'));
const Reports = lazy(() => import('@/pages/Reports'));
const Clauses = lazy(() => import('@/pages/Clauses'));
const ContractDraft = lazy(() => import('@/pages/ContractDraft'));
const ContractQuery = lazy(() => import('@/pages/ContractQuery'));
const Settlements = lazy(() => import('@/pages/Settlements'));
const SettlementLedgerPage = lazy(() =>
  import('@/pages/Settlements').then((m) => ({ default: m.SettlementLedgerPage })),
);
const SystemUsersPage = lazy(() => import('@/pages/System').then((m) => ({ default: m.SystemUsersPage })));
const SystemRolesPage = lazy(() => import('@/pages/System').then((m) => ({ default: m.SystemRolesPage })));
const SystemParamsPage = lazy(() => import('@/pages/System').then((m) => ({ default: m.SystemParamsPage })));
const SystemLogsPage = lazy(() => import('@/pages/System').then((m) => ({ default: m.SystemLogsPage })));
// 采购管理（批次一：采购模板 + 七个阶段模块）
const ProcurementTemplates = lazy(() => import('@/pages/Procurement/Templates'));
const ProcurementInitiate = lazy(() => import('@/pages/Procurement/Initiate'));
const ProcurementPreMeetingMinutes = lazy(() => import('@/pages/Procurement/PreMeetingMinutes'));
const ProcurementNotice = lazy(() => import('@/pages/Procurement/Notice'));
const ProcurementDocument = lazy(() => import('@/pages/Procurement/Document'));
const ProcurementResultReport = lazy(() => import('@/pages/Procurement/ResultReport'));
const ProcurementPriceCompare = lazy(() => import('@/pages/Procurement/PriceCompare'));
const ProcurementFrameworkExplanation = lazy(() => import('@/pages/Procurement/FrameworkExplanation'));

/**
 * 路由元素工厂：按 `ROUTE_PERMISSIONS` 自动包裹权限守卫。
 * 用工厂而非逐条手写包裹，避免 40+ 条路由漏包（权限码与维护约定见 @/constants/routePermissions）。
 */
function perm(path: string, element: ReactNode): ReactNode {
  const codes = routePermissionCodes(path);
  return codes.length ? <RequirePermission codes={codes}>{element}</RequirePermission> : element;
}

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

      // —— 合同管理 ——
      { path: 'contract/list', element: perm('/contract/list', <Ledger />) },
      { path: 'contract/material', element: perm('/contract/material', <ContractMaterials />) },
      { path: 'contract/draft', element: perm('/contract/draft', <ContractDraft />) },
      { path: 'contract/query', element: perm('/contract/query', <ContractQuery />) },

      // —— 采购管理（批次一）——
      // 菜单与路由守卫均为 `contract:view`（后端 `/procurement-tasks` 的权限码），三者一致
      { path: 'procurement/initiate', element: perm('/procurement/initiate', <ProcurementInitiate />) },
      { path: 'procurement/pre-meeting', element: perm('/procurement/pre-meeting', <ProcurementPreMeetingMinutes />) },
      { path: 'procurement/notice', element: perm('/procurement/notice', <ProcurementNotice />) },
      { path: 'procurement/document', element: perm('/procurement/document', <ProcurementDocument />) },
      { path: 'procurement/result-report', element: perm('/procurement/result-report', <ProcurementResultReport />) },
      { path: 'procurement/price-compare', element: perm('/procurement/price-compare', <ProcurementPriceCompare />) },
      { path: 'procurement/framework', element: perm('/procurement/framework', <ProcurementFrameworkExplanation />) },
      { path: 'base/procurement-template', element: perm('/base/procurement-template', <ProcurementTemplates />) },

      // —— 日报管理 ——
      { path: 'daily/report', element: perm('/daily/report', <DailyReports />) },
      { path: 'daily/receipt', element: perm('/daily/receipt', <ReceiptOrders />) },
      { path: 'daily/asset', element: perm('/daily/asset', <Assets />) },

      // —— 结算及付款管理 ——
      { path: 'settlement/order', element: perm('/settlement/order', <Settlements />) },
      { path: 'settlement/fund', element: perm('/settlement/fund', <Finance />) },
      { path: 'settlement/ledger', element: perm('/settlement/ledger', <SettlementLedgerPage />) },
      { path: 'settlement/payment', element: perm('/settlement/payment', <Payments />) },
      { path: 'settlement/payment-procedure', element: perm('/settlement/payment-procedure', <PaymentProcedures />) },
      { path: 'settlement/final-settlement', element: perm('/settlement/final-settlement', <FinalSettlements />) },

      // —— 发票 / 还款 / 消息 / 报表 ——
      { path: 'invoice', element: perm('/invoice', <Invoices />) },
      { path: 'repayment', element: perm('/repayment', <Repayments />) },
      { path: 'message', element: <Messages /> },
      { path: 'statistics', element: perm('/statistics', <Reports />) },

      // —— 基础信息管理 ——
      { path: 'base/project', element: perm('/base/project', <Projects />) },
      { path: 'base/supplier', element: perm('/base/supplier', <Suppliers />) },
      { path: 'base/subcontractor', element: perm('/base/subcontractor', <Subcontractors />) },
      { path: 'base/material', element: perm('/base/material', <Materials />) },
      { path: 'base/template', element: perm('/base/template', <Templates />) },
      { path: 'base/doc-template', element: perm('/base/doc-template', <DocTemplates />) },
      { path: 'base/clause', element: perm('/base/clause', <Clauses />) },

      // —— 系统管理 ——
      { path: 'system', element: <Navigate to="/system/user" replace /> },
      { path: 'system/user', element: perm('/system/user', <SystemUsersPage />) },
      { path: 'system/role', element: perm('/system/role', <SystemRolesPage />) },
      { path: 'system/params', element: perm('/system/params', <SystemParamsPage />) },
      { path: 'system/dict', element: perm('/system/dict', <Dict />) },
      { path: 'system/log', element: perm('/system/log', <SystemLogsPage />) },

      // —— 旧扁平路径（历史书签 / 深链兼容）：**重定向保号** ——
      // 原约定是「新旧路径并存，勿删」（两套路径渲染同一组件）；此处收敛为 301 式重定向：
      // URL 仍然可用（书签不失效），但不再重复维护两套路由映射，也不再重复打包同一页面。
      // 例外：`contracts`（合同编辑页）在新菜单中没有对应入口，保留为真实路由，去留待确认（见 TODO.md）。
      { path: 'dict', element: <Navigate to="/system/dict" replace /> },
      { path: 'projects', element: <Navigate to="/base/project" replace /> },
      { path: 'suppliers', element: <Navigate to="/base/supplier" replace /> },
      { path: 'subcontractors', element: <Navigate to="/base/subcontractor" replace /> },
      { path: 'templates', element: <Navigate to="/base/template" replace /> },
      { path: 'materials', element: <Navigate to="/base/material" replace /> },
      { path: 'daily', element: <Navigate to="/daily/report" replace /> },
      { path: 'receipt-orders', element: <Navigate to="/daily/receipt" replace /> },
      { path: 'assets', element: <Navigate to="/daily/asset" replace /> },
      { path: 'contract-materials', element: <Navigate to="/contract/material" replace /> },
      { path: 'ledger', element: <Navigate to="/contract/list" replace /> },
      { path: 'settlements', element: <Navigate to="/settlement/order" replace /> },
      { path: 'finance', element: <Navigate to="/settlement/fund" replace /> },
      { path: 'payments', element: <Navigate to="/settlement/payment" replace /> },
      { path: 'invoices', element: <Navigate to="/invoice" replace /> },
      { path: 'repayments', element: <Navigate to="/repayment" replace /> },
      { path: 'messages', element: <Navigate to="/message" replace /> },
      { path: 'reports', element: <Navigate to="/statistics" replace /> },
      // `contracts` 为旧合同编辑页，不与任何新路径重复，故保留为真实路由（未登记权限 → 不拦截）
      { path: 'contracts', element: <Contracts /> },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
];
