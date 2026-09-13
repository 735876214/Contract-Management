# ---------- 构建阶段 ----------
FROM node:20-slim AS build
WORKDIR /app/server

# 安装全部依赖（含 prisma / nest 等开发依赖，供 generate 与 build 使用）
COPY package.json ./
RUN npm install --legacy-peer-deps

# 复制源码，生成 prisma client（使用 sqlite schema，与运行时一致），再编译
COPY . .
RUN npx prisma generate --schema prisma/schema.sqlite.prisma
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production

# 复制构建产物与依赖（保留 prisma CLI，以便在启动时同步数据库结构）
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/prisma ./prisma
COPY --from=build /app/server/package.json ./package.json

EXPOSE 3000

# 启动顺序（重要，否则 SQLite 是空文件、表不存在）：
#   1) prisma db push  —— 把 schema 同步到 /data/cms.db（本项目 SQLite 运行时用 db push，
#      而非 migrate deploy；migrations/ 下是 postgres 语法，不适用于 SQLite）。
#   2) mkdir -p $UPLOAD_DIR —— 确保上传目录存在。
#   3) node dist/src/main —— 启动服务。
# 权限：镜像默认以 root 运行，可直接写入 bind mount 的 /data。
# 若你改用非 root 用户（如 PUID/PGID），请先在宿主机 chown：
#   sudo chown -R 1026:100 /volume1/docker/cms/data   # 群晖常见 1026；威联通 GID 可能不同
CMD ["sh", "-c", "npx prisma db push --schema prisma/schema.sqlite.prisma --skip-generate && mkdir -p \"$UPLOAD_DIR\" && node dist/src/main"]
