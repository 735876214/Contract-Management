/**
 * 路由级权限表：path → 允许进入的权限码（**任一即可**）。
 *
 * 背景：权限原仅作用于侧边菜单过滤（`useAuthStore.hasPermission`），直接输入 URL 可进入无权页面
 * ——后端仍会返回 403，但页面表现为「空壳 + 报错」，体验差。本表配合 `RequirePermission`
 * 在路由层拦截，直接给出 403 页面。
 *
 * 维护约定（由 `server/test/routePermissionParity.spec.mts` 守卫）：
 * 1. 本表的 path 必须存在于后端 `MENU_TREE`（菜单权威来源）；
 * 2. 菜单中带 `permission` 的路径**必须**登记，且登记项必须**包含**菜单要求的权限码
 *    —— 即路由守卫**不得比菜单更严**，否则会出现「菜单可见、点进去 403」；
 * 3. 未登记的路径 = 不拦截（如 `/message`，后端这些接口本身不做权限校验）。
 */
export const ROUTE_PERMISSIONS: Record<string, string[]> = {
  // 采购管理（后端 `/procurement-tasks` 要求 `contract:view`，菜单同一权限码）
  '/procurement/initiate': ['contract:view'],
  '/procurement/pre-meeting': ['contract:view'],
  '/procurement/notice': ['contract:view'],
  '/procurement/document': ['contract:view'],
  '/procurement/result-report': ['contract:view'],
  '/procurement/price-compare': ['contract:view'],
  '/procurement/framework': ['contract:view'],
  // 合同管理
  '/contract/draft': ['contract:view'],
  '/contract/query': ['contract:view'],
  '/contract/list': ['contract:view'],
  '/contract/material': ['material:view'],
  // 日报管理
  '/daily/report': ['daily:view'],
  '/daily/receipt': ['receipt:view'],
  '/daily/asset': ['asset:view'],
  // 结算及付款管理
  '/settlement/order': ['settlement:view'],
  // 资金费用拆成两个独立模块（2026-10-16）：权限码沿用 finance:view（同一批人维护）
  '/settlement/factoring': ['finance:view'],
  '/settlement/overdue': ['finance:view'],
  '/settlement/ledger': ['settlement:view'],
  '/settlement/payment': ['payment:view'],
  // 付款手续编制：复用付款管理的权限码（同一批人管，不新开一套）
  '/settlement/payment-procedure': ['payment:view'],
  // 总结算单：结算域单据，复用结算权限码
  '/settlement/final-settlement': ['settlement:view'],
  // 单据模板：复用合同模板的权限码（同一批人维护模板）
  '/base/doc-template': ['template:view'],
  // 发票 / 还款 / 统计报表
  '/invoice': ['invoice:view'],
  '/repayment': ['repayment:view'],
  '/statistics': ['dashboard:view'],
  // 劳务管理 / 成本管理 / 项目资料归档（附件需求 2026-10-17 新增）
  '/labor/auth': ['labor:view'],
  '/cost/receiving': ['cost:view'],
  '/cost/profit-loss': ['cost:view'],
  '/archive': ['archive:view'],
  // 基础信息管理
  '/base/project': ['project:view'],
  '/base/supplier': ['supplier:view'],
  '/base/subcontractor': ['subcontractor:view'],
  '/base/material': ['material:view'],
  '/base/template': ['template:view'],
  '/base/procurement-template': ['template:view'],
  '/base/clause': ['template:view'],
  // 系统管理（`/system/dict` 例外：后端允许 `dict:view` **或** `system:config`，故两者皆可进入）
  '/system/user': ['system:user'],
  '/system/role': ['system:role'],
  '/system/params': ['system:config'],
  '/system/dict': ['dict:view', 'system:config'],
  '/system/log': ['system:user'],
};

/**
 * 菜单中带权限码、但**有意不做**路由守卫的路径。
 * - `/dashboard`：默认落地页（`/` 与未匹配路由都重定向到这里），若按 `dashboard:view` 拦截，
 *   没有该权限的账号登录后会立刻看到 403 而不是工作台；后端 dashboard 接口本身也不校验权限。
 */
export const ROUTE_PERMISSION_EXCEPTIONS: string[] = ['/dashboard'];

/** 该路径是否需要权限校验，以及允许的权限码集合（未登记 → 允许所有人） */
export function routePermissionCodes(path: string): string[] {
  return ROUTE_PERMISSIONS[path] ?? [];
}

/** 依据 `hasPermission` 判定是否可进入该路径（未登记或无可用权限码时放行） */
export function isRouteAllowed(path: string, hasPermission: (code: string) => boolean): boolean {
  const codes = routePermissionCodes(path);
  if (codes.length === 0) return true;
  return codes.some((code) => hasPermission(code));
}
