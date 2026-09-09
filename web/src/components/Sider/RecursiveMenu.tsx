import { useMemo } from 'react';
import type { ItemType } from 'antd/es/menu/interface';
import { Menu } from 'antd';
import type { MenuItem, RecursiveMenuProps } from './types';
import { renderIcon } from './utils/iconHelper';
import { isLeaf } from './utils/menuHelper';

/**
 * 递归菜单渲染（需求 5.4）
 *
 * - 支持无限层级嵌套：叶子节点渲染为 Item，非叶子节点渲染为 SubMenu
 * - useMemo 缓存递归转换结果，菜单数据/导航回调不变时不重复计算
 */

/** 单个节点 → antd ItemType（内部递归） */
function toItem(node: MenuItem, onNavigate: (path: string) => void): ItemType {
  if (isLeaf(node)) {
    return {
      key: node.key,
      icon: renderIcon(node.icon),
      label: node.label,
      title: node.label,
      onClick: node.path ? () => onNavigate(node.path as string) : undefined,
    };
  }
  return {
    key: node.key,
    icon: renderIcon(node.icon),
    label: node.label,
    children: (node.children as MenuItem[]).map((child) => toItem(child, onNavigate)),
  };
}

/** 递归菜单组件 */
export default function RecursiveMenu({
  items,
  selectedKeys,
  openKeys,
  onOpenChange,
  onNavigate,
}: RecursiveMenuProps) {
  const antdItems = useMemo<ItemType[]>(() => items.map((node) => toItem(node, onNavigate)), [items, onNavigate]);

  return (
    <Menu
      mode="inline"
      theme="dark"
      items={antdItems}
      selectedKeys={selectedKeys}
      openKeys={openKeys}
      onOpenChange={onOpenChange}
    />
  );
}
