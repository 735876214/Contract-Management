import type { ReactNode } from 'react';
import {
  DashboardOutlined,
  ProfileOutlined,
  FileTextOutlined,
  CalendarOutlined,
  DollarOutlined,
  FileProtectOutlined,
  BellOutlined,
  BarChartOutlined,
  DatabaseOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  AppstoreOutlined,
  FileExcelOutlined,
  FundOutlined,
  AuditOutlined,
  MoneyCollectOutlined,
  BookOutlined,
  PayCircleOutlined,
  ProjectOutlined,
  TeamOutlined,
  SnippetsOutlined,
  UserOutlined,
  SafetyOutlined,
  ApartmentOutlined,
  ControlOutlined,
  FileSearchOutlined,
  FileAddOutlined,
  FileOutlined,
  ContainerOutlined,
  SolutionOutlined,
  SearchOutlined,
} from '@ant-design/icons';

/**
 * 图标名称 → React 组件映射表（需求 4.3 / 5.5）
 * 后端只返回图标名字符串，前端据此动态渲染；未知名称兜底 FileOutlined。
 */
const ICON_MAP: Record<string, React.ComponentType> = {
  DashboardOutlined,
  FileTextOutlined,
  CalendarOutlined,
  DollarOutlined,
  FileProtectOutlined,
  BellOutlined,
  BarChartOutlined,
  DatabaseOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  AppstoreOutlined,
  FileExcelOutlined,
  FundOutlined,
  AuditOutlined,
  MoneyCollectOutlined,
  BookOutlined,
  PayCircleOutlined,
  ProjectOutlined,
  TeamOutlined,
  SnippetsOutlined,
  UserOutlined,
  SafetyOutlined,
  ApartmentOutlined,
  ControlOutlined,
  FileSearchOutlined,
  FileAddOutlined,
  ContainerOutlined,
  SolutionOutlined,
  SearchOutlined,
};

/** 图标兜底组件（需求 11：图标名不存在时使用 FileOutlined） */
export const FALLBACK_ICON_NAME = 'FileOutlined';
ICON_MAP[FALLBACK_ICON_NAME] = FileOutlined;

// antd v5 图标库无 FileInvoiceOutlined（需求文档指定名），别名映射到最接近的 ProfileOutlined
ICON_MAP.FileInvoiceOutlined = ProfileOutlined;

/**
 * 将菜单项的 icon 字段渲染为 React 节点。
 * - 已是 ReactNode：原样返回
 * - 字符串：查映射表，未知名称兜底 FileOutlined
 * - 空值：兜底 FileOutlined
 */
export function renderIcon(icon?: string | ReactNode): ReactNode {
  if (icon && typeof icon !== 'string') return icon;
  const name = typeof icon === 'string' && ICON_MAP[icon] ? icon : FALLBACK_ICON_NAME;
  const Component = ICON_MAP[name];
  return <Component />;
}
