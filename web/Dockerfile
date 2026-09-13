# ---------- 构建阶段 ----------
FROM node:20-slim AS build
WORKDIR /app/web

# 关键：生产构建使用相对路径 /api（不写死 localhost:3000），
# 这样浏览器会访问「当前 NAS 域名 /api」，再由 nginx 反向代理到 backend。
ENV VITE_API_BASE=/api

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
FROM nginx:alpine

COPY --from=build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
