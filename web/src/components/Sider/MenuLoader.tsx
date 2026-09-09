import { useEffect } from 'react';
import { Alert, Button, Empty, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { MenuLoaderProps } from './types';
import { useMenuData } from './hooks/useMenuData';

/**
 * 菜单加载容器（需求 5.5 / 11）
 *
 * - 加载中：Spin 动画
 * - 接口失败：错误提示 + 重试按钮，同时使用本地 MENU_CONFIG 兜底渲染
 * - 接口返回空数据：「暂无菜单数据」占位
 * - 加载成功：render-prop 向外抛出菜单数据，并通过 onMenu 同步给父组件（供高亮/展开/搜索使用）
 */
export default function MenuLoader({ children, onMenu }: MenuLoaderProps) {
  const { menu, loading, error, isFallback, reload } = useMenuData();

  useEffect(() => {
    onMenu?.(menu);
  }, [menu, onMenu]);

  if (loading) {
    return (
      <div className="sider-loader__status">
        <Spin tip="菜单加载中..." size="small">
          <div style={{ height: 80, width: '100%' }} />
        </Spin>
      </div>
    );
  }

  if (menu.length === 0) {
    return (
      <div className="sider-loader__status">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无菜单数据" />
        <Button size="small" icon={<ReloadOutlined />} onClick={reload}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="sider-loader">
      {error && isFallback && (
        <Alert
          className="sider-loader__fallback-tip"
          type="warning"
          showIcon
          message="菜单接口加载失败，已使用本地菜单"
          action={
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={reload}>
              重试
            </Button>
          }
        />
      )}
      {children(menu)}
    </div>
  );
}
