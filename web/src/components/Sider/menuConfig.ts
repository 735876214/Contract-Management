import type { MenuItem } from './types';

/**
 * 本地菜单兜底配置（需求 5.5：接口失败时使用 MENU_CONFIG 兜底）
 * 层级与路径严格按需求 4.1 / 八、路径映射表 生成。
 * 路径为新规范路径，路由层已做旧路径别名，二者均可访问。
 */
export const MENU_CONFIG: MenuItem[] = [
  { key: 'dashboard', label: '工作台', icon: 'DashboardOutlined', path: '/dashboard' },
  {
    key: 'contract',
    label: '合同管理',
    icon: 'FileTextOutlined',
    children: [
      { key: 'contract-draft', label: '合同起草', icon: 'FileAddOutlined', path: '/contract/draft', permission: 'contract:view' },
      // 需求 2.2：新增「合同查询」二级菜单（已发布/正式合同，含导出 Word）
      { key: 'contract-query', label: '合同查询', icon: 'SearchOutlined', path: '/contract/query', permission: 'contract:view' },
      { key: 'contract-list', label: '合同台账', icon: 'UnorderedListOutlined', path: '/contract/list', permission: 'contract:view' },
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
      { key: 'settlement-fund', label: '资金费用台账', icon: 'MoneyCollectOutlined', path: '/settlement/fund', permission: 'finance:view' },
      { key: 'settlement-ledger', label: '结算台账', icon: 'BookOutlined', path: '/settlement/ledger', permission: 'settlement:view' },
      { key: 'settlement-payment', label: '付款管理', icon: 'PayCircleOutlined', path: '/settlement/payment', permission: 'payment:view' },
    ],
  },
  { key: 'invoice', label: '发票管理', icon: 'FileInvoiceOutlined', path: '/invoice', permission: 'invoice:view' },
  { key: 'repayment', label: '还款协议', icon: 'FileProtectOutlined', path: '/repayment', permission: 'repayment:view' },
  { key: 'message', label: '消息中心', icon: 'BellOutlined', path: '/message' },
  { key: 'statistics', label: '统计报表', icon: 'BarChartOutlined', path: '/statistics', permission: 'dashboard:view' },
  {
    key: 'base',
    label: '基础信息管理',
    icon: 'DatabaseOutlined',
    children: [
      { key: 'base-project', label: '项目管理', icon: 'ProjectOutlined', path: '/base/project', permission: 'project:view' },
      { key: 'base-supplier', label: '供应商库', icon: 'TeamOutlined', path: '/base/supplier', permission: 'supplier:view' },
      // 需求 2.1：新增「分包商库」，通过分包材料员授权委托书同步信息
      { key: 'base-subcontractor', label: '分包商库', icon: 'SolutionOutlined', path: '/base/subcontractor', permission: 'subcontractor:view' },
      { key: 'base-material', label: '物资基础库', icon: 'DatabaseOutlined', path: '/base/material', permission: 'material:view' },
      { key: 'base-template', label: '合同模板', icon: 'SnippetsOutlined', path: '/base/template', permission: 'template:view' },
      // 需求 2.2 修正：合同条款即条款管理页面（原「条款库」名称删除），直接作为叶子菜单
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
      { key: 'system-dept', label: '部门管理', icon: 'ApartmentOutlined', path: '/system/dept', permission: 'system:dept' },
      { key: 'system-params', label: '系统参数', icon: 'ControlOutlined', path: '/system/params', permission: 'system:config' },
      { key: 'system-dict', label: '字典管理', icon: 'BookOutlined', path: '/system/dict', permission: 'dict:view' },
      { key: 'system-log', label: '日志', icon: 'FileSearchOutlined', path: '/system/log', permission: 'system:user' },
    ],
  },
];
