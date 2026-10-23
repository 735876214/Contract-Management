/**
 * 菜单配置（**菜单权威来源**，前端 `Sider/menuConfig.ts` 只是接口失败时的兜底）。
 *
 * 抽到 `constants/` 而非留在 `menu.service.ts`：与 `procurementFlow.ts` 同样保持
 * **零运行时依赖**，便于 `server/test/routePermissionParity.spec.mts` 直接加载校验，
 * 以及前端路由守卫（`web/src/constants/routePermissions.ts`）与菜单不漂移。
 *
 * 约定：
 * - `permission` 为对应模块的查看权限码；无权限的项（含子级全部无权限的分组）整体隐藏；
 * - 改菜单结构后需递增前端 `Sider/utils/storage.ts` 的缓存键版本；
 * - 新增图标须在 `Sider/utils/helper.tsx` 的 ICON_MAP 注册。
 */

/** 菜单项结构（icon 为图标名字符串，前端动态映射） */
export interface MenuNode {
  key: string;
  label: string;
  icon: string;
  path?: string;
  permission?: string;
  children?: MenuNode[];
}

export const MENU_TREE: MenuNode[] = [
  { key: 'dashboard', label: '工作台', icon: 'DashboardOutlined', path: '/dashboard', permission: 'dashboard:view' },
  // 采购管理模块（位于合同管理上方）
  // 说明：与前端 Sider/menuConfig.ts 的采购分组保持一致；子项权限码为 contract:view
  //       ——与后端 `/procurement-tasks` 的 @RequirePermissions 一致，避免出现
  //       「菜单可见但点进去只有空壳（接口 403）」；前端路由守卫登记同一权限码
  //       （web/src/constants/routePermissions.ts，由 routePermissionParity 单测锁定）。
  {
    key: 'procurement',
    label: '采购管理',
    icon: 'ShoppingCartOutlined',
    children: [
      { key: 'procurement-initiate', label: '采购发起', icon: 'RocketOutlined', path: '/procurement/initiate', permission: 'contract:view' },
      { key: 'procurement-pre-meeting', label: '采前会会议纪要', icon: 'FileDoneOutlined', path: '/procurement/pre-meeting', permission: 'contract:view' },
      { key: 'procurement-notice', label: '采购公告', icon: 'NotificationOutlined', path: '/procurement/notice', permission: 'contract:view' },
      { key: 'procurement-document', label: '采购文件', icon: 'FolderOpenOutlined', path: '/procurement/document', permission: 'contract:view' },
      { key: 'procurement-result-report', label: '成交报告', icon: 'TrophyOutlined', path: '/procurement/result-report', permission: 'contract:view' },
      { key: 'procurement-price-compare', label: '采购价格对比表', icon: 'BarChartOutlined', path: '/procurement/price-compare', permission: 'contract:view' },
      { key: 'procurement-framework', label: '框架协议事前说明', icon: 'FileSyncOutlined', path: '/procurement/framework', permission: 'contract:view' },
    ],
  },
  {
    key: 'contract',
    label: '合同管理',
    icon: 'FileTextOutlined',
    children: [
      { key: 'contract-draft', label: '合同起草', icon: 'FileAddOutlined', path: '/contract/draft', permission: 'contract:view' },
      // 需求 2.2：新增「合同查询」二级菜单（已发布/正式合同，含导出 Word）
      { key: 'contract-query', label: '合同查询', icon: 'SearchOutlined', path: '/contract/query', permission: 'contract:view' },
      { key: 'contract-list', label: '合同台账', icon: 'UnorderedListOutlined', path: '/contract/list', permission: 'contract:view' },
      // 合同台账维护（业务 2026-10-17 补回菜单入口）：/contracts 的列表+编辑器页签，承接起草页「继续编辑」
      { key: 'contract-edit', label: '合同台账维护', icon: 'EditOutlined', path: '/contracts', permission: 'contract:view' },
      { key: 'contract-material', label: '合同物资清单', icon: 'AppstoreOutlined', path: '/contract/material', permission: 'material:view' },
    ],
  },
  {
    key: 'daily',
    label: '日报管理',
    icon: 'CalendarOutlined',
    children: [
      { key: 'daily-report', label: '总日报', icon: 'FileExcelOutlined', path: '/daily/report', permission: 'daily:view' },
      // 需求：收领单与总日报平级
      { key: 'daily-receipt', label: '收领单', icon: 'ContainerOutlined', path: '/daily/receipt', permission: 'receipt:view' },
      { key: 'daily-asset', label: '资产台账', icon: 'FundOutlined', path: '/daily/asset', permission: 'asset:view' },
    ],
  },
  {
    key: 'settlement',
    label: '结算及付款管理',
    icon: 'DollarOutlined',
    children: [
      { key: 'settlement-order', label: '结算单', icon: 'AuditOutlined', path: '/settlement/order', permission: 'settlement:view' },
      // 资金费用拆成两个独立菜单（业务口径 2026-10-16）：两张表结构完全不同，
      // 挤在一个页面里既没法分别配权限，也没法各自套结算台账的标准列表页骨架
      { key: 'settlement-factoring', label: '保理费用台账', icon: 'MoneyCollectOutlined', path: '/settlement/factoring', permission: 'finance:view' },
      { key: 'settlement-overdue', label: '逾期利息台账', icon: 'FundOutlined', path: '/settlement/overdue', permission: 'finance:view' },
      { key: 'settlement-ledger', label: '结算台账', icon: 'BookOutlined', path: '/settlement/ledger', permission: 'settlement:view' },
      { key: 'settlement-payment', label: '付款管理', icon: 'PayCircleOutlined', path: '/settlement/payment', permission: 'payment:view' },
      // 总结算单（业务口径 2026-10-16）：抓取该合同全部月度结算 → 附件上传 → 已结算 → 合同已完已结
      { key: 'settlement-final', label: '总结算单', icon: 'FileDoneOutlined', path: '/settlement/final-settlement', permission: 'settlement:view' },
      // 付款手续编制（业务口径 2026-10-16）：开累结算/付款/未付款三值由服务端按合同链口径取数
      { key: 'settlement-payment-procedure', label: '付款手续', icon: 'FileDoneOutlined', path: '/settlement/payment-procedure', permission: 'payment:view' },
    ],
  },
  { key: 'invoice', label: '发票管理', icon: 'FileInvoiceOutlined', path: '/invoice', permission: 'invoice:view' },
  { key: 'repayment', label: '还款协议', icon: 'FileProtectOutlined', path: '/repayment', permission: 'repayment:view' },
  // 分包管理（附件需求 2026-10-17 新增一级模块；原「劳务管理」统一改名 2026-10-17）：分包授权台账
  {
    key: 'labor',
    label: '分包管理',
    icon: 'TeamOutlined',
    children: [
      { key: 'labor-auth', label: '分包授权台账', icon: 'SolutionOutlined', path: '/labor/auth', permission: 'labor:view' },
    ],
  },
  // 成本管理（附件需求 2026-10-17 新增一级模块）：分包领用汇总 + 盈亏分析
  {
    key: 'cost',
    label: '成本管理',
    icon: 'FundProjectionScreenOutlined',
    children: [
      { key: 'cost-labor-receiving', label: '分包单位领用汇总', icon: 'CalculatorOutlined', path: '/cost/labor-receiving', permission: 'cost:view' },
      { key: 'cost-profit-loss', label: '盈亏分析', icon: 'PieChartOutlined', path: '/cost/profit-loss', permission: 'cost:view' },
    ],
  },
  { key: 'message', label: '消息中心', icon: 'BellOutlined', path: '/message' },
  // AI 助手（2026-10-19）：上传文件自动登记 / 模版自动填报 / 自动生成汇报材料
  { key: 'ai', label: 'AI 助手', icon: 'RobotOutlined', path: '/ai/assistant', permission: 'ai:view' },
  // 结算/付款异常预警（课题 6-9，2026-10-23）：独立入口而非 AI 助手的页签——
  // 它是财务月度核对的常驻动作，埋进页签会找不到；权限沿用 ai:view（不新增权限码，免迁移 seed）
  { key: 'ai-anomaly', label: '结算异常预警', icon: 'SafetyOutlined', path: '/ai/anomaly', permission: 'ai:view' },
  // 异常报价与价差预警（课题 3-9，2026-10-24）：采购定标前的价差/围标核对入口。
  // 权限同样沿用 ai:view（不新增权限码，免迁移 seed）；报价与控制价的可见性由
  // 接口内 contract:view 二次校验兜底。
  { key: 'ai-quote', label: '报价异常预警', icon: 'AuditOutlined', path: '/ai/quote', permission: 'ai:view' },
  { key: 'ai-fulfillment', label: '履约偏差预警', icon: 'AuditOutlined', path: '/ai/fulfillment', permission: 'ai:view' },
  { key: 'statistics', label: '统计报表', icon: 'BarChartOutlined', path: '/statistics', permission: 'dashboard:view' },
  // 项目资料归档（附件需求 2026-10-17）：按需求目录树一键打包 ZIP
  { key: 'archive', label: '项目资料归档', icon: 'FolderOpenOutlined', path: '/archive', permission: 'archive:view' },
  {
    key: 'base',
    label: '基础信息管理',
    icon: 'DatabaseOutlined',
    children: [
      { key: 'base-project', label: '项目管理', icon: 'ProjectOutlined', path: '/base/project', permission: 'project:view' },
      { key: 'base-supplier', label: '供应商库', icon: 'TeamOutlined', path: '/base/supplier', permission: 'supplier:view' },
      // 「分包商库」已并入「劳务管理 → 分包授权台账」（附件需求 2026-10-17；菜单删除，/base/subcontractor 保号重定向）
      { key: 'base-material', label: '物资基础库', icon: 'DatabaseOutlined', path: '/base/material', permission: 'material:view' },
      { key: 'base-template', label: '合同模板', icon: 'SnippetsOutlined', path: '/base/template', permission: 'template:view' },
      // 单据模板（业务口径 2026-10-17）：结算单/总结算单/保理单/逾期利息/付款单五类 Excel 模板
      { key: 'base-doc-template', label: '单据模板', icon: 'FileDoneOutlined', path: '/base/doc-template', permission: 'template:view' },
      // 批次一 · 任务 1.2：采购模板（各采购模块 Word 模板管理）
      { key: 'base-procurement-template', label: '采购模板', icon: 'ShoppingOutlined', path: '/base/procurement-template', permission: 'template:view' },
      { key: 'base-clause', label: '合同条款', icon: 'FileTextOutlined', path: '/base/clause', permission: 'template:view' },
    ],
  },
  {
    key: 'system',
    label: '系统管理',
    icon: 'SettingOutlined',
    children: [
      { key: 'system-user', label: '用户管理', icon: 'UserOutlined', path: '/system/user', permission: 'system:user' },
      { key: 'system-role', label: '角色管理', icon: 'SafetyOutlined', path: '/system/role', permission: 'system:role' },
      { key: 'system-params', label: '系统参数', icon: 'ControlOutlined', path: '/system/params', permission: 'system:config' },
      { key: 'system-dict', label: '字典管理', icon: 'BookOutlined', path: '/system/dict', permission: 'dict:view' },
      { key: 'system-log', label: '日志', icon: 'FileSearchOutlined', path: '/system/log', permission: 'system:user' },
      // AI 信息登记（2026-10-20 需求）：登记全站共用的上游地址 / API Key / 模型名，
      // 让 AI 助手不依赖 docker 环境变量也能用。权限 `system:config`——
      // 这改的是全站配置（含密钥），只给管理员，业务用户看不到。
      { key: 'system-ai-register', label: 'AI 信息登记', icon: 'RobotOutlined', path: '/system/ai-register', permission: 'system:config' },
    ],
  },
];

/** 展平菜单树为 [{ path, permission }]，忽略无 path 的分组节点 */
export function flattenMenu(nodes: MenuNode[] = MENU_TREE): Array<{ path: string; permission?: string }> {
  const out: Array<{ path: string; permission?: string }> = [];
  const walk = (list: MenuNode[]): void => {
    for (const n of list) {
      if (n.path) out.push({ path: n.path, permission: n.permission });
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

