import { Breadcrumb } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { BreadcrumbNavProps } from './types';
import { useMenuData } from './hooks/useMenuData';
import { useBreadcrumb } from './hooks/useBreadcrumb';

/** 面包屑导航（需求 5.3）：内容区顶部，根据当前路由自动更新，除当前页外均可点击 */
export default function BreadcrumbNav({ homeLabel = '工作台', homePath = '/dashboard' }: BreadcrumbNavProps) {
  const navigate = useNavigate();
  const { menu } = useMenuData();
  const items = useBreadcrumb(menu, homeLabel, homePath);

  return (
    <Breadcrumb
      className="sider-breadcrumb"
      items={items.map((item) => ({
        title: item.path ? (
          <a onClick={() => navigate(item.path as string)}>{item.label}</a>
        ) : (
          <span className="sider-breadcrumb__current">{item.label}</span>
        ),
      }))}
    />
  );
}
