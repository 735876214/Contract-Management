import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import 'antd/dist/reset.css';
import './index.css';
// 组件级 Container Queries：**必须排在 index.css 之后**（同特异度规则靠顺序压过基线），
// 该顺序由 `server/test/containerQuery.spec.mts` 锁定。见 DESIGN.md §10。
import './styles/containers.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

/**
 * PWA：注册最小 Service Worker（docs/09 §4 阶段 C）。
 *
 * **只在生产构建注册**：dev 下 Vite 按需编译、模块 URL 不稳定，SW 缓存会和 HMR 打架
 * （表现为改了代码刷新还是旧页面，且难排查）。SW 只缓存应用壳与静态资源，
 * 业务数据（/api/**）永远走网络，见 `public/sw.js` 的文件头注释。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 注册失败（非 HTTPS / 浏览器不支持）不影响正常使用，只是失去离线壳 */
    });
  });
}
