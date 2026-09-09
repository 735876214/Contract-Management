import { Injectable } from '@nestjs/common';
import { JwtUser } from '../../common/decorators/user.decorator';

/** 后端菜单项结构（icon 为图标名字符串，前端动态映射） */
export interface MenuNode {
  key: string;
  label: string;
  icon: string;
  path?: string;
  permission?: string;
  children?: MenuNode[];
}

/**
 * 菜单配置与权限过滤：
 * - 层级/图标/路径与前端 Sider 组件需求 4.1/4.3/八 严格一致
 * - permission 为对应模块的查看权限码，无权限的项（含子级全部无权限的分组）整体隐藏
 */
const MENU_TREE: MenuNode[] = [
  { key: 'dashboard', label: '工作台', icon: 'DashboardOutlined', path: '/dashboard', permission: 'dashboard:view' },
  {
    key: 'contract',
    label: '合同管理',
    icon: 'FileTextOutlined',
    children: [
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
      { key: 'base-material', label: '物资基础库', icon: 'DatabaseOutlined', path: '/base/material', permission: 'material:view' },
      { key: 'base-template', label: '合同模板', icon: 'SnippetsOutlined', path: '/base/template', permission: 'template:view' },
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

@Injectable()
export class MenuService {
  /** 返回当前用户可见的菜单树 */
  getMenuForUser(user: JwtUser): MenuNode[] {
    const permissions = new Set<string>(user?.permissions || []);
    const isSuperAdmin = !!user?.isSuperAdmin;

    const filter = (nodes: MenuNode[]): MenuNode[] => {
      const out: MenuNode[] = [];
      for (const node of nodes) {
        if (node.permission && !isSuperAdmin && !permissions.has(node.permission)) continue;
        if (node.children) {
          const children = filter(node.children);
          if (children.length === 0) continue; // 子菜单全部无权限 → 分组整体隐藏
          out.push({ ...node, children });
        } else {
          out.push(node);
        }
      }
      return out;
    };

    return filter(MENU_TREE);
  }
}
