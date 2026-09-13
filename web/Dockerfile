# ============================================================================
# CMS 前端（React + Vite + Ant Design）生产镜像 —— 多阶段构建
#
#   ① deps    安装依赖（含 devDependencies，vite/tsc 构建需要）
#   ② build   npm run build（tsc --noEmit 类型检查 + vite build）→ dist/
#   ③ runtime nginx:alpine 只承载 dist 静态产物
#
# 体积控制：
#   - 运行阶段已是 nginx:alpine（数十 MB 级）+ 约 3MB 的 dist，构建期的 node_modules
#     （本地实测 335MB）天然不进最终镜像，这是多阶段构建最大的收益点。
#   - deps 阶段与 build 阶段分离，并且只先 COPY package.json，改源码不会重装依赖。
#   - VITE_API_BASE=/api 使用相对路径，浏览器请求「当前域名 /api」，由 nginx 反代到 backend，
#     不写死 NAS 内网地址，镜像才能做到一次构建到处部署。
# ============================================================================

# ---------- ① 依赖 ----------
FROM node:20-slim AS deps
WORKDIR /app/web
COPY package.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund \
 && npm cache clean --force

# ---------- ② 构建 ----------
FROM deps AS build

# 关键：生产构建用相对路径 /api（不写死 localhost:3000）
ENV VITE_API_BASE=/api

COPY . .
RUN npm run build

# ---------- ③ 运行 ----------
FROM nginx:alpine AS runtime

COPY --from=build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
