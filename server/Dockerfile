# ---------- 构建阶段 ----------
FROM node:20-slim AS build
# Prisma 的 schema/query 引擎是依赖 OpenSSL 共享库的二进制；node:20-slim (Debian bookworm)
# 默认没装 openssl，会导致 `prisma generate` / `prisma db push` 报
# "Schema engine error: Please manually install OpenSSL"，后端启动即崩。
# 此处安装 openssl（含 libssl3），并清缓存保持镜像精简。
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
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
# 运行时同样需要 openssl：容器启动时 `CMD` 里的 `prisma db push` 会调用 schema 引擎二进制，
# 缺 openssl 会 Schema engine error 崩溃（日志可见 502 / upstream Host is unreachable）。
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
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
