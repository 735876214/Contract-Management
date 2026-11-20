import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// /api 反代目标：默认指向宿主机直跑的后端（localhost:3000）；
// 用 docker-compose.dev.yml 跑前端容器时，由 VITE_PROXY_TARGET 注入 http://server:3000。
const apiProxyTarget = process.env.VITE_PROXY_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd', '@ant-design/icons'],
          echarts: ['echarts', 'echarts-for-react'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // 前端少数页面直接 import 后端的共享计算引擎（`../../../server/src/common/calc/*.ts`），
    // 该文件在 web 目录之外，需显式允许 vite 读取（宿主机跑与容器跑都指向同一相对位置）。
    fs: { allow: ['.', path.resolve(__dirname, '../server')] },
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
