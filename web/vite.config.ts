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
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
