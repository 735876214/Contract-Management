import { useEffect } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { routes } from './router';
import { antdTheme } from './theme';
import { authApi } from './api/auth';

const router = createBrowserRouter(routes);

/**
 * 应用外壳：**主题的唯一入口**（DESIGN.md §1）。
 * token 全部来自 [theme.ts](theme.ts)——改视觉只改那一处，页面里不写死色值。
 */
export default function App() {
  // 已有本地 token 的会话补发文件 Cookie（/api/files/** 与 GET 下载不再使用 URL token）
  useEffect(() => {
    if (localStorage.getItem('cms_token')) authApi.fileSession().catch(() => undefined);
  }, []);
  return (
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  );
}
