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
