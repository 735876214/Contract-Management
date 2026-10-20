import type { MenuItem } from './types';

/**
 * 本地菜单兜底配置（需求 5.5：接口失败时使用 MENU_CONFIG 兜底）
 * 层级与路径严格按需求 4.1 / 八、路径映射表 生成。
 * 路径为新规范路径，路由层已做旧路径别名，二者均可访问。
 */
export const MENU_CONFIG: MenuItem[] = [
  { key: 'dashboard', label: '工作台', icon: 'DashboardOutlined', path: '/dashboard' },
  // 批次一 · 任务 1.1：采购管理模块（位于合同管理上方）
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
      // 合同台账维护（业务 2026-10-17 补回菜单入口）：/contracts 的列表+编辑器页签
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
      { key: 'settlement-factoring', label: '保理费用台账', icon: 'MoneyCollectOutlined', path: '/settlement/factoring', permission: 'finance:view' },
      { key: 'settlement-overdue', label: '逾期利息台账', icon: 'FundOutlined', path: '/settlement/overdue', permission: 'finance:view' },
      { key: 'settlement-ledger', label: '结算台账', icon: 'BookOutlined', path: '/settlement/ledger', permission: 'settlement:view' },
      { key: 'settlement-payment', label: '付款管理', icon: 'PayCircleOutlined', path: '/settlement/payment', permission: 'payment:view' },
    ],
  },
  { key: 'invoice', label: '发票管理', icon: 'FileInvoiceOutlined', path: '/invoice', permission: 'invoice:view' },
    // 分包管理 / 成本管理 / 项目资料归档（附件需求 2026-10-17 新增）
  { key: 'labor', label: '分包管理', icon: 'TeamOutlined', children: [{ key: 'labor-auth', label: '分包授权台账', icon: 'SolutionOutlined', path: '/labor/auth', permission: 'labor:view' }] },
  { key: 'cost', label: '成本管理', icon: 'FundProjectionScreenOutlined', children: [{ key: 'cost-labor-receiving', label: '分包单位领用汇总', icon: 'CalculatorOutlined', path: '/cost/labor-receiving', permission: 'cost:view' }, { key: 'cost-profit-loss', label: '盈亏分析', icon: 'PieChartOutlined', path: '/cost/profit-loss', permission: 'cost:view' }] },
  { key: 'archive', label: '项目资料归档', icon: 'FolderOpenOutlined', path: '/archive', permission: 'archive:view' },
{ key: 'repayment', label: '还款协议', icon: 'FileProtectOutlined', path: '/repayment', permission: 'repayment:view' },
  { key: 'message', label: '消息中心', icon: 'BellOutlined', path: '/message' },
  // AI 助手（2026-10-19）：fallback 菜单，结构须与后端 MENU_TREE 保持一致
  { key: 'ai', label: 'AI 助手', icon: 'RobotOutlined', path: '/ai/assistant', permission: 'ai:view' },
  { key: 'statistics', label: '统计报表', icon: 'BarChartOutlined', path: '/statistics', permission: 'dashboard:view' },
  {
    key: 'base',
    label: '基础信息管理',
    icon: 'DatabaseOutlined',
    children: [
      { key: 'base-project', label: '项目管理', icon: 'ProjectOutlined', path: '/base/project', permission: 'project:view' },
      { key: 'base-supplier', label: '供应商库', icon: 'TeamOutlined', path: '/base/supplier', permission: 'supplier:view' },
      // 需求 2.1：新增「分包商库」，通过分包材料员授权委托书同步信息
      { key: 'base-material', label: '物资基础库', icon: 'DatabaseOutlined', path: '/base/material', permission: 'material:view' },
      { key: 'base-template', label: '合同模板', icon: 'SnippetsOutlined', path: '/base/template', permission: 'template:view' },
      // 批次一 · 任务 1.2：采购模板（各采购模块 Word 模板管理）
      { key: 'base-procurement-template', label: '采购模板', icon: 'ShoppingOutlined', path: '/base/procurement-template', permission: 'template:view' },
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
      { key: 'system-params', label: '系统参数', icon: 'ControlOutlined', path: '/system/params', permission: 'system:config' },
      { key: 'system-dict', label: '字典管理', icon: 'BookOutlined', path: '/system/dict', permission: 'dict:view' },
      { key: 'system-log', label: '日志', icon: 'FileSearchOutlined', path: '/system/log', permission: 'system:log' },
      // AI 信息登记（2026-10-20）：结构须与后端 MENU_TREE 保持一致；
      // 这是全站上游配置（含密钥），权限 system:config，只给管理员
      { key: 'system-ai-register', label: 'AI 信息登记', icon: 'RobotOutlined', path: '/system/ai-register', permission: 'system:config' },
    ],
  },
];

