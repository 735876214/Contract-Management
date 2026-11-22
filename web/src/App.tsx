import { useEffect } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { routes } from './router';
import { antdTheme } from './theme';
import { authApi } from './api/auth';
import { bindAntdMessage } from './utils/antdStatic';

const router = createBrowserRouter(routes);

/**
 * 把 <AntdApp> 的主题化 message 绑到静态调用点（见 src/utils/antdStatic.ts）。
 *
 * 组件外的 message.success(...)（http 拦截器、工具函数）拿不到 ConfigProvider 的上下文，
 * 直接用 antd 静态 API 会丢主题并在控制台报警；这里在 React 树内取一次带上下文的实例存过去，
 * 全部调用点无需改动。**必须渲染在 <AntdApp> 内部**。
 */
function AntdStaticBridge() {
  const { message } = AntdApp.useApp();
  useEffect(() => {
    bindAntdMessage(message);
  }, [message]);
  return null;
}

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
        <AntdStaticBridge />
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  );
}
