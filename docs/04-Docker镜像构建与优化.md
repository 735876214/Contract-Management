# 04 · Docker 镜像构建与优化

> 记录单容器镜像的构建流程、关键踩坑与取舍。运维/部署步骤见 [../README.md](../README.md)，
> 开发命令见 [development.md](development.md)。
>
> 涉及文件：[deploy/single/Dockerfile.single](../deploy/single/Dockerfile.single) ·
> [deploy/single/nginx.conf](../deploy/single/nginx.conf) ·
> [deploy/single/start.sh](../deploy/single/start.sh) ·
> [docker-compose.yml](../docker-compose.yml) · [.github/workflows/build.yml](../.github/workflows/build.yml)

## 1. 为什么是「单容器」

部署平台对容器数量有限制，或多容器长时间运行后易被按配额逐个回收/终止。
因此把**前端静态托管（nginx）+ 后端（NestJS）+ /api 反代**合并进**一个**镜像：
对外只暴露一个端口，nginx 把 `/api` 反代到同容器 `127.0.0.1:3000`。

但 **PostgreSQL 仍是独立服务**（`docker-compose.yml` 的 `postgres` 服务 + bind mount 到 NAS 数据目录），
不放进应用镜像——数据库需要独立持久化与生命周期。

```
docker-compose.yml
├── postgres:16-alpine     卷 = NAS 路径（如 /volume1/docker/cms/pgdata），healthcheck pg_isready
└── cms (ghcr.io/735876214/cms-single)
      node:20-slim 内：nginx :8080（静态 + /api 反代） + Node :3000
      对外 9080 → 8080；上传落 NAS 路径（如 /volume1/docker/cms/data）
```

## 2. Dockerfile 五个阶段

基础镜像统一 `node:20-slim`。**镜像与本地开发统一用 npm**（`npm ci --legacy-peer-deps`，锁文件已入库）。

| 阶段 | 做什么 | 关键点 |
|---|---|---|
| `backend-deps` | COPY `server/package.json` → `npm install --legacy-peer-deps` | 只带 package.json，依赖层可缓存 |
| `backend-build` | COPY `server/` → `prisma generate` + `nest build` | 产出 `dist/` |
| `backend-proddeps` | 生产依赖 + Prisma CLI | 见 §3.1、§3.2 |
| `frontend-build` | COPY `web/` → `VITE_API_BASE=/api` + `vite build` | 产出 `web/dist` |
| `runtime` | 装 openssl/nginx/tzdata，合并上述产物 | 见 §2.1 |

### 2.1 runtime 合并了哪些产物

```
从 backend-proddeps → /app/server/node_modules   （只拷生产依赖，不拷 build 阶段的完整 node_modules）
从 backend-build    → /app/server/dist、package.json、prisma/
从 frontend-build   → /usr/share/nginx/html
deploy/single/nginx.conf → /etc/nginx/conf.d/default.conf
deploy/single/start.sh   → /usr/local/bin/start.sh
```

- `apt-get install openssl ca-certificates nginx tzdata`（带 `-o Acquire::Retries=5`）。
  `openssl` 供 Prisma 查询引擎；`nginx` 托管前端与反代；`tzdata` 让 `TZ=Asia/Shanghai` 生效
  （合同到期日等按本地时区计算）。
- runtime 层清理 `apt` 缓存、`/usr/share/doc`、`/usr/share/man`
  —— ⚠️ **镜像体积 = 各层之和**，`RUN rm -rf` 必须与产生文件的操作**放在同一层**（这里 apt 安装与清理同一 `RUN`），
  否则只是在运行层"看不见"，体积不变。
- `EXPOSE 8080`；`HEALTHCHECK` 用 `node -e "require('net').connect(8080,...)"` 探测对外端口
  （`node:20-slim` **不带 wget**，不能用 wget 探针）。

## 3. 关键踩坑

### 3.1 prisma 是 devDependency，但运行时要用它的 CLI

`start.sh` 需要 `prisma` CLI 执行 `migrate deploy`。但 `prisma` 在 `server/package.json` 里属 `devDependencies`：

- ❌ `npm install --no-save --omit=dev prisma@^5.10.2` **无效**：npm 认为 spec 已被满足，日志只打印
  `up to date in 1s`，`node_modules/.bin/prisma` 并不生成，下一步报 `not found`（退出码 **127**）。
- ✅ 正确做法：安装前用 `node -e` 把 `prisma` **临时挪进 `dependencies`**，再 `npm install --omit=dev`。
  随后断言 `test -x ./node_modules/.bin/prisma` 兜底。
- ⚠️ **不能加 `--ignore-scripts`**：否则 prisma 的 `postinstall` 不下载 schema-engine，启动 `migrate deploy` 会崩。

### 3.2 generate 必须显式带上 schema

`backend-proddeps` 只 COPY 过 `package.json`，做 `prisma generate` 前**必须显式 `COPY server/prisma ./prisma`**。
此前靠 Docker 层缓存"侥幸"通过，一旦 `package.json` 变化导致缓存失效，就报
`Could not find Prisma Schema`。

### 3.3 基础镜像与 Prisma 的 OpenSSL

Prisma 的查询引擎依赖 openssl/schema-engine，故运行镜像显式安装 `openssl`；
早期缺它会导致后端启动崩溃。

### 3.4 start.sh 必须用 bash

`node:20-slim` 的 `/bin/sh` 指向 **dash**，不支持 `wait -n`。若用 `#!/bin/sh`，脚本启动即报
`Illegal option -n` 退出，容器起不来。故 shebang 用 `#!/usr/bin/env bash`。

此外：`wait -n "$NODE_PID" "$NGINX_PID" || STATUS=$?` 必须写成 `|| STATUS=$?`
——`set -e` 下裸 `wait` 返回非 0 会直接终止脚本，导致 `stop_all` 收不到尾、子进程留在半死状态。

### 3.5 apt 镜像源偶发失败

镜像源偶发 502 / 连接超时（走代理时更常见）会让构建随机失败，故 apt 命令统一带
`-o Acquire::Retries=5`。

## 4. nginx.conf 要点

| 配置 | 值 | 原因 |
|---|---|---|
| `listen` | `8080` | 与应用容器对外端口一致 |
| `client_max_body_size` | `50m` | 合同 Word / 附件上传，防 413 |
| `gzip` | on，`comp_level 5`，`min_length 1024` | antd + echarts 产物体积大，压缩后首屏传输约降至 1/3 |
| `location ^~ /assets/` | `expires 1y` + `immutable` | 带 hash 的构建产物长期强缓存 |
| `location = /index.html` | `no-cache, must-revalidate` | 防发版后浏览器仍用旧 index 引用已删除的旧 chunk |
| `location /api/` | `proxy_pass http://127.0.0.1:3000/api/` | 反代到**同容器**后端；带 Host / X-Real-IP / X-Forwarded-For / X-Forwarded-Proto |
| API 超时 | connect 10s / send 300s / read 300s | 合同、报表导出（exceljs、html-to-docx）耗时较长，防 504 |
| `location /` | `try_files $uri $uri/ /index.html` | SPA 路由回退，刷新子路由不 404 |

## 5. start.sh 启动流程

```
prisma generate → prisma migrate deploy        # 空库则应用折叠基线一次建全表
mkdir -p "${UPLOAD_DIR:-/data/uploads}"
node dist/src/main &          → NODE_PID       # 后端
nginx -g 'daemon off;' &      → NGINX_PID      # 前端（作为容器存活锚点）
trap 'stop_all; exit 143' INT TERM             # 143 = 128+SIGTERM，不被 restart 视为异常崩溃
wait -n ...  →  任一进程退出即整体退出          # 交由 restart 策略自愈
```

## 6. CI 构建与发布

[.github/workflows/build.yml](../.github/workflows/build.yml)：

- **触发**：push `main`、push tag `v*`、PR 到 `main`（仅验证可构建，不推送）、`workflow_dispatch`。
- **镜像 tag**：`latest`（main / v*）、`sha-<sha>`、semver（v* tag）；PR 用 `ref` tag。
- **平台**：**仅 `linux/amd64`**（NAS 主流 x86_64；arm64 需 QEMU，会慢数倍）。
- **加速**：buildx + GHA 层缓存（`cache-from/to: type=gha, scope=cms-single, mode=max`）；
  `provenance: false`、`sbom: false`（避免 SLSA 证明附加 unknown 平台导致旧版 Docker 报 no matching manifest）。
- **推送目标**：`ghcr.io/<owner 小写>/cms-single`（无需 token 即可拉取的公开包）。

## 7. 本地构建

```bash
# 只构建镜像
docker build -f deploy/single/Dockerfile.single -t cms-single:local .

# 构建并启动（compose 已内置 build: 段）
docker compose up -d --build
```

## 8. 现状与取舍（可复核）

- **基础镜像用 `node:20-slim`（Debian）而非 alpine**：Prisma 依赖 glibc/openssl，
  Debian 系兼容性更稳；镜像体积的代价换取了运行期确定性。
- **前端用 nginx 托管，而非 Node 静态服务**：nginx 处理静态资源、缓存头与 gzip 更成熟，
  也是单容器方案的既定选择（前端与后端同容器，nginx 作存活锚点）。
- **镜像内构建统一用 npm**：`--legacy-peer-deps` 在容器内更稳定，避免把带符号链接的
  `node_modules` 结构问题带入镜像。**2026-10 起本地开发也统一为 npm**（锁文件入库，
  镜像与 CI 同为 `npm ci --legacy-peer-deps`）；pnpm 在镜像内曾评估并放弃（符号链接跨阶段 COPY 易踩坑）。
- **未采用 distroless**：需要 nginx、prisma CLI、shell（`start.sh`）与运行期迁移，
  distroless 无 shell 无法承载该启动流程。

> 若后续要压体积，优先方向：合并 apt 安装层（已做）、评估将 `web/dist` 与
> `server/node_modules` 的拷贝进一步瘦身；不建议改用 alpine（Prisma/openssl 风险）。
