import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { routes } from './router';
import { antdTheme } from './theme';

const router = createBrowserRouter(routes);

/**
 * 应用外壳：**主题的唯一入口**（DESIGN.md §1）。
 * token 全部来自 [theme.ts](theme.ts)——改视觉只改那一处，页面里不写死色值。
 */
export default function App() {
  return (
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  );
}
