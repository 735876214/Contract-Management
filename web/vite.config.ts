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
    // 共享计算引擎（@cms/calc）是 CJS 产物（server 侧 ts-node 直接 require 它），且经 file: 依赖
    // **软链**到 packages/calc。默认 vite 会把软链解析成真实路径，于是它被当成「源码」而不是依赖，
    // rollup 的 commonjs 互操作不会处理它 → 报 "calcPriceWithTax is not exported by ...amounts.js"。
    // 保留软链路径（模块 id 仍在 node_modules 下）后，CJS→ESM 互操作与依赖预构建恢复正常。
    preserveSymlinks: true,
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
    // 2026-11-23 P3：共享计算引擎已抽成 `@cms/calc` 包（`file:` 依赖，真实路径在 node_modules 里），
    // 不再需要 fs.allow 去读 web/ 之外的目录。
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
