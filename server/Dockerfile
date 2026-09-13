# ============================================================================
# CMS 后端（NestJS + Prisma + SQLite）生产镜像 —— 多阶段构建
#
# 阶段总览（最终镜像 = runtime 阶段产物，其余阶段全部丢弃）：
#   ① base     node:20-slim + openssl + ca-certificates      —— 公共基座
#   ② deps     安装【全部】依赖（含 devDependencies）        —— 供 nest build 使用
#   ③ build    prisma generate + nest build → dist/          —— 编译产物
#   ④ proddeps 全新安装【仅生产依赖 + prisma CLI】并瘦身      —— 运行所需 node_modules
#   ⑤ runtime  合并 dist + proddeps/node_modules + prisma/    —— 最终镜像
#
# 相比旧版 Dockerfile 的关键优化：
#   1) 旧版 `COPY --from=build .../node_modules` 把构建期的 @nestjs/cli、typescript、
#      ts-node、@nestjs/schematics、@angular-devkit、webpack 等全部搬进运行镜像
#      （实测本地 node_modules 373MB，其中约 150MB+ 是纯构建工具链，线上完全无用）。
#      新版在独立阶段用 `npm install --omit=dev` 重装生产依赖，工具链零残留。
#   2) 瘦身动作（删 *.md / *.map / *.d.ts / LICENSE 等）放在 proddeps 阶段内部完成，
#      因为最终镜像是通过一次 COPY 生产的单 layer，只包含 COPY 那一刻的扁平结果，
#      proddeps 的中间层再大也不会进入最终镜像。（注意：若在运行镜像里再新开一层
#      `RUN rm -rf ...`，镜像体积不会变小 —— 镜像体积 = 各层之和。）
#   3) 依赖层的 COPY 顺序为 package.json → npm install → COPY . .，改源码不会使依赖层失效。
#   4) 刻意保留 prisma CLI（约 40~60MB）：容器启动时要执行 `prisma db push` 把 schema
#      同步到挂载卷里的 SQLite 文件（表结构演进依赖它），它是运行时必需而非构建残留。
#      若你改为「用 migrate deploy + 官方 postgres」，可删掉 proddeps 里的 prisma CLI
#      安装行与 CMD 中的 db push，镜像还能再小一档。
# ============================================================================

# ---------- ① 公共基座 ----------
FROM node:20-slim AS base
WORKDIR /app/server

# Prisma 的 schema/query 引擎是依赖 OpenSSL 共享库的二进制；node:20-slim 默认不带 openssl，
# 缺失会导致 `prisma generate` / `prisma db push` 报 "Please manually install OpenSSL"。
# 文档与 man 页一并清理，减少无用占用。
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man

# ---------- ② 全量依赖（构建用） ----------
FROM base AS deps

# 先只复制清单文件并安装依赖：源码频繁变更时可直接命中该层缓存
COPY package.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

# ---------- ③ 编译 ----------
FROM deps AS build
COPY . .

# 必须与运行时保持一致：使用 SQLite schema 生成 client
# （内联 DATABASE_URL： prisma 校验 schema 时会解析 datasource 的 env()，缺值在部分版本会直接报错）
RUN DATABASE_URL="file:/tmp/prisma-generate.db" \
      ./node_modules/.bin/prisma generate --schema prisma/schema.sqlite.prisma
RUN DATABASE_URL="file:/tmp/prisma-generate.db" npm run build

# ---------- ④ 生产依赖（运行用） ----------
FROM base AS proddeps

COPY package.json ./
# ① 只装生产依赖：构建工具链（nest cli / typescript / ts-node / schematics）就此止步
# ② 再单独补装 prisma CLI：这里【不能】带 --ignore-scripts，否则其 postinstall 不会下载
#    schema-engine 二进制，容器启动时 db push 会失败。版本范围须与 devDependencies 对齐。
#    （第一步故意不加 --ignore-scripts：避免个别生产依赖的 postinstall 被跳过导致运行期缺件）
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund \
 && npm install --no-save --omit=dev --legacy-peer-deps --no-audit --no-fund "prisma@^5.10.2"

# 在此阶段而非 build 阶段生成 client，保证 client 与将要运行的 @prisma/client 完全同源同版
COPY prisma/schema.sqlite.prisma ./prisma/
RUN DATABASE_URL="file:/tmp/prisma-generate.db" \
      ./node_modules/.bin/prisma generate --schema prisma/schema.sqlite.prisma

# 瘦身：删除运行时不需要的类型定义、文档、许可证、source map（均在后续 COPY 前完成，有效）
#   - *.d.ts / *.map  ：仅 TS 开发与堆栈映射需要，运行时用不到
#   - *.md / LICENSE* ：纯文本，体积虽小但数量多
# 有意保留：node_modules/.prisma 下的查询引擎（运行时查询必需）、prisma CLI 与 schema-engine。
RUN find ./node_modules -type f -regextype posix-extended \
      -regex '.*(\.md|\.markdown|\.map|\.d\.ts|/LICENSE[^/]*|/CHANGELOG[^/]*|/AUTHORS[^/]*|/NOTICE[^/]*)' \
      -delete \
 && find ./node_modules -type d -name '.github' -prune -exec rm -rf {} + \
 && npm cache clean --force

# ---------- ⑤ 运行镜像 ----------
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3000

# 生产依赖（已在 proddeps 中瘦身）
COPY --from=proddeps /app/server/node_modules ./node_modules
# 编译产物
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/package.json ./package.json
# prisma/ 在运行时必需：schema.sqlite.prisma（启动时 db push 用）+ templates/（合同模板文件）
COPY --from=build /app/server/prisma ./prisma

EXPOSE 3000

# 无 /health 路由，故用端口探测做健康检查（db push + seed 完成前会短暂失败，故给足启动宽限期）
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "require('net').connect(process.env.PORT||3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

# 启动顺序（缺一不可，否则 SQLite 是空文件、表不存在）：
#   1) prisma db push —— 把 schema 同步到 DATABASE_URL 指向的 SQLite 文件。
#      本项目 SQLite 运行时走 db push 而非 migrate deploy：migrations/ 下是 postgres 语法。
#   2) mkdir -p ${UPLOAD_DIR} —— 确保上传目录存在（给默认值，避免环境变量缺失时 mkdir 空串报错）。
#   3) node dist/src/main —— 启动服务（内含首次空库 seed）。
# 以 root 运行：便于直接写入 bind mount 的 /data；改用非 root 请先在宿主机 chown 对应目录。
CMD ["sh", "-c", "./node_modules/.bin/prisma db push --schema prisma/schema.sqlite.prisma --skip-generate && mkdir -p \"${UPLOAD_DIR:-/data/uploads}\" && node dist/src/main"]
