import type { MenuItem } from './types';

/**
 * 本地菜单兜底配置（`/api/menu` 失败时使用）。
 *
 * ⚠️ 本文件必须与后端权威源 `server/src/constants/menuTree.ts` **逐项同序**——
 * `server/test/routePermissionParity.spec.mts` 用 deepEqual 锁定两者，改菜单时两处一起改。
 * 顺序不是装饰：兜底态下用户看到的层级与正式态必须一致，否则排障时会误判"菜单丢了"。
 */
export const MENU_CONFIG: MenuItem[] = [
  { key: 'dashboard', label: '工作台', icon: 'DashboardOutlined', path: '/dashboard', permission: 'dashboard:view' },
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
      { key: 'contract-query', label: '合同查询', icon: 'SearchOutlined', path: '/contract/query', permission: 'contract:view' },
      { key: 'contract-list', label: '合同台账', icon: 'UnorderedListOutlined', path: '/contract/list', permission: 'contract:view' },
      { key: 'contract-material', label: '合同物资清单', icon: 'AppstoreOutlined', path: '/contract/material', permission: 'material:view' },
    ],
  },
  {
    key: 'daily',
    label: '现场管理',
    icon: 'CalendarOutlined',
    children: [
      { key: 'daily-report', label: '总日报', icon: 'FileExcelOutlined', path: '/daily/report', permission: 'daily:view' },
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
      { key: 'settlement-factoring', label: '保理费用台账', icon: 'MoneyCollectOutlined', path: '/settlement/factoring', permission: 'finance:view' },
      { key: 'settlement-overdue', label: '逾期利息台账', icon: 'FundOutlined', path: '/settlement/overdue', permission: 'finance:view' },
      { key: 'settlement-ledger', label: '结算台账', icon: 'BookOutlined', path: '/settlement/ledger', permission: 'settlement:view' },
      { key: 'settlement-payment', label: '付款管理', icon: 'PayCircleOutlined', path: '/settlement/payment', permission: 'payment:view' },
      { key: 'settlement-final', label: '总结算单', icon: 'FileDoneOutlined', path: '/settlement/final-settlement', permission: 'settlement:view' },
      { key: 'settlement-payment-procedure', label: '付款手续', icon: 'FileDoneOutlined', path: '/settlement/payment-procedure', permission: 'payment:view' },
    ],
  },
  { key: 'invoice', label: '发票管理', icon: 'FileInvoiceOutlined', path: '/invoice', permission: 'invoice:view' },
  { key: 'repayment', label: '还款协议', icon: 'FileProtectOutlined', path: '/repayment', permission: 'repayment:view' },
  {
    key: 'cost',
    label: '分包与成本管理',
    icon: 'FundProjectionScreenOutlined',
    children: [
      { key: 'labor-auth', label: '分包授权台账', icon: 'SolutionOutlined', path: '/labor/auth', permission: 'labor:view' },
      { key: 'cost-labor-receiving', label: '分包单位领用汇总', icon: 'CalculatorOutlined', path: '/cost/labor-receiving', permission: 'cost:view' },
      { key: 'cost-profit-loss', label: '盈亏分析', icon: 'PieChartOutlined', path: '/cost/profit-loss', permission: 'cost:view' },
    ],
  },
  { key: 'message', label: '消息中心', icon: 'BellOutlined', path: '/message' },
  {
    key: 'ai',
    label: 'AI 助手',
    icon: 'RobotOutlined',
    children: [
      { key: 'ai-assistant', label: 'AI 助手', icon: 'RobotOutlined', path: '/ai/assistant', permission: 'ai:view' },
      { key: 'ai-analytics', label: '经营数据助手', icon: 'BarChartOutlined', path: '/ai/analytics', permission: 'ai:view' },
    ],
  },
  {
    key: 'ai-insight',
    label: '智能分析',
    icon: 'BarChartOutlined',
    children: [
      { key: 'ai-anomaly', label: '结算异常预警', icon: 'SafetyOutlined', path: '/ai/anomaly', permission: 'ai:view' },
      { key: 'ai-quote', label: '报价异常预警', icon: 'AuditOutlined', path: '/ai/quote', permission: 'ai:view' },
      { key: 'ai-fulfillment', label: '履约偏差预警', icon: 'AuditOutlined', path: '/ai/fulfillment', permission: 'ai:view' },
      { key: 'ai-analysis', label: '供应链全景', icon: 'BarChartOutlined', path: '/ai/analysis', permission: 'ai:view' },
    ],
  },
  { key: 'statistics', label: '统计报表', icon: 'BarChartOutlined', path: '/statistics', permission: 'dashboard:view' },
  { key: 'archive', label: '项目资料归档', icon: 'FolderOpenOutlined', path: '/archive', permission: 'archive:view' },
  {
    key: 'base',
    label: '基础信息管理',
    icon: 'DatabaseOutlined',
    children: [
      { key: 'base-project', label: '项目管理', icon: 'ProjectOutlined', path: '/base/project', permission: 'project:view' },
      { key: 'base-supplier', label: '供应商库', icon: 'TeamOutlined', path: '/base/supplier', permission: 'supplier:view' },
      { key: 'base-material', label: '物资基础库', icon: 'DatabaseOutlined', path: '/base/material', permission: 'material:view' },
      { key: 'base-template', label: '合同模板', icon: 'SnippetsOutlined', path: '/base/template', permission: 'template:view' },
      { key: 'base-doc-template', label: '单据模板', icon: 'FileDoneOutlined', path: '/base/doc-template', permission: 'template:view' },
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
      { key: 'system-ai-register', label: 'AI 信息登记', icon: 'RobotOutlined', path: '/system/ai-register', permission: 'system:config' },
    ],
  },
];
