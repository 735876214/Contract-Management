# 04 · Docker 镜像构建与体积优化

> 适用场景：NAS（群晖 / 威联通 / Unraid）部署。变更文件：`server/Dockerfile`、`web/Dockerfile`、
> `web/nginx.conf`、`server/.dockerignore`、`web/.dockerignore`、`docker-compose.build.yml`。

## 一、当前架构与交付链路

```
浏览器 ── HTTPS(NAS 反向代理) ──► cms-frontend :9080
                                    │  nginx:alpine
                                    │  ├─ /            SPA 静态产物（web/dist）
                                    │  └─ /api/  ────► cms-backend :3000（docker 内网，不对外暴露）
                                                        │  NestJS 10 + Prisma 5
                                                        └─ /data 卷（SQLite cms.db + uploads/）
```

| 组成 | 技术栈 | 对外端口 | 数据落盘 |
| --- | --- | --- | --- |
| frontend | React 18 + Vite 5 + AntD 5 + echarts | `${CMS_HTTP_PORT:-9080}` | 无状态 |
| backend | NestJS 10 + Prisma 5（SQLite） | 不暴露，仅内网 3000 | bind mount `/data` |

交付链路：push 到 `main` → GitHub Actions（`.github/workflows/build.yml`，linux/amd64，buildx + GHA 层缓存）
→ 推送到 **公开** 仓库 ghcr.io/735876214/cms-{backend,frontend}:latest → NAS 上 `docker compose up -d`
（`pull_policy: always`，无需源码、无需 token）。

**因为是公开镜像，任何被打进鏡像的文件都等于公开**——这是 `.dockerignore` 里必须屏蔽 `.env` 的原因。

## 二、后端多阶段 Dockerfile（`server/Dockerfile`）

| # | 阶段 | 作用 | 是否进最终镜像 |
| --- | --- | --- | --- |
| ① | `base` | node:20-slim + openssl + ca-certificates | 是（作为运行底座） |
| ② | `deps` | 安装**全部**依赖（含 devDependencies） | 否 |
| ③ | `build` | `prisma generate` + `nest build` → `dist/` | 否（只取 dist、prisma 目录） |
| ④ | `proddeps` | 全新安装**仅生产依赖 + prisma CLI** 并瘦身、生成 client | 只取其 node_modules |
| ⑤ | `runtime` | 合并 dist + node_modules + prisma/ | **这是最终产物** |

关键点：

- **Prisma 必须装 openssl**：`schema-engine` / `query-engine` 是动态链接 OpenSSL 的二进制，
  `node:20-slim` 默认不装，缺了会在 `db push` 阶段直接崩。
- **Prisma Client 在 `proddeps` 阶段就地生成**（而非从 build 阶段拷过来），保证 client 与运行时
  `@prisma/client` 完全同源同版。
- **`prisma/目录`必须进运行镜像**：里面既有启动时要用的 `schema.sqlite.prisma`，
  也有 `templates/`（合同模板），少了任一个启动即失败。
- **保留 prisma CLI**：启动脚本靠 `prisma db push` 把表结构同步到卷里的 SQLite 文件，属于运行时必需。
  这是约 40~60MB 的「必要成本」，详见第五节的可选替代方案。

## 三、前端 Dockerfile（`web/Dockerfile`）

- `deps → build → runtime(nginx:alpine)`，运行镜像只含 3MB 级别的 `dist`。
  构建期的 300MB+ `node_modules` 天然被隔离在中间阶段。
- `VITE_API_BASE=/api` 使用**相对路径**，浏览器请求「当前域名 /api」，由 nginx 反代到 backend，
  镜像与部署域名彻底解耦。
- nginx 侧新增优化：`gzip`（显式列出 `gzip_types`，Nginx 默认只压 `text/html`）、
  `/assets/` 带 hash 产物 `immutable` 强缓存、`/index.html` 禁缓存（防止发版后引用到已删除的旧 chunk）、
  `/api/` 读写超时放宽到 300s（合同 Word / Excel 导出耗时较长）。

## 四、已落地的体积优化清单

| 优化项 | 说明 |
| --- | --- |
| **生产依赖与构建依赖分离** | 旧写法 `COPY --from=build .../node_modules` 把 @nestjs/cli、typescript、ts-node、@nestjs/schematics、@angular-devkit、webpack 等全部搬进运行镜像；新版在 `proddeps` 阶段用 `npm install --omit=dev` 重装，构建工具链零残留（**本项收益最大**） |
| **瘦身动作前置到被 COPY 的阶段** | 镜像体积 = 各层之和，**在运行镜像里新开一层 `RUN rm -rf` 并不会变小**；因此 `find -delete` 清理放在 `proddeps` 内部，最终由一次 `COPY` 生成单 layer，只包含清理后的扁平结果 |
| 清理 node_modules 冗余文件 | 删 `*.d.ts` / `*.map` / `*.md` / `LICENSE*` / `CHANGELOG*` / `.github`；有意保留查询引擎与 schema-engine |
| apt 单层安装即清理 | `apt-get install` 与 `rm -rf /var/lib/apt/lists/*`、`/usr/share/doc`、`/usr/share/man` 同一层完成 |
| `.dockerignore` 加固 | 排除 `.env` / `.env.*`（公开镜像泄漏风险）、本地 37MB 的 `web/.npm-cache`、`uploads`、`*.db`、`e2e-*.py`、`test-*.ts`、`_nm_broken_web` |
| 依赖层缓存友好 | `COPY package.json` → `npm install` → `COPY . .`，改源码不触发重装依赖 |
| 无用 download 抑制 | `--no-audit --no-fund` + `npm cache clean --force` |
| 健康检查 | 后端无 `/health` 路由，改用 node 端口探测（`start-period=90s` 覆盖 db push + seed 时间）；前端用 busybox `wget` 探首页 |

> 体量参考：本机 Windows `server/node_modules` 实测 373MB，其中纯构建工具链约 150MB+（新版已剔除）。
> Linux 容器内绝对值不同，`proddeps` 的 node_modules 预计从「全量约 300MB 级」降到「约 150MB 级」。
> **本机无 Docker 环境，未实际构建测量，上述为估算。**

## 五、未采用 / 可选进阶（含风险，按需启用）

| 方案 | 收益 | 风险 |
| --- | --- | --- |
| 基础镜像换 `node:20-alpine` | 再省约 50~60MB | Prisma 引擎需 musl 版本（`linux-musl-openssl-3.0.x`），官方虽支持但版本组合敏感；未经本机构建验证，**不建议直接上生产** |
| 去掉 prisma CLI（DB 结构改在构建期固化为模板 db） | 再省 40~60MB | 会失去「每次启动自动演进表结构」的能力，后续加字段升级镜像时旧库不会迁移，属行为退化 |
| 换 `distroless/nodejs` 底座 | 体积最小、无 shell | 当前 CMD 依赖 `sh -c`（db push + node），需改写入口脚本，改造量大 |
| pnpm `--frozen-lockfile` 替代 npm install | 可复现、安装更快 | 项目里 `package-lock.json` 被 .gitignore（只用 pnpm-lock.yaml）；pnpm 的符号链接 node_modules 跨阶段 COPY 易踩坑，需真机构建验证 |

> 若要改 pnpm：中间阶段可用 `pnpm deploy --prod`/`--frozen-lockfile`，但务必先在有 Docker 的机器上验证
> `node_modules/.prisma` 的生成位置（pnpm 下 client 可能落在 `.pnpm` 虚拟目录里）。

## 六、本地构建验证（需 Docker）

```bash
# 默认 compose 拉 ghcr.io 预构建镜像；本地验证时用覆盖层从源码构建
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build

# 观察后端启动日志（应看到 db push 成功 + CMS server running）
docker compose logs -f backend

# 对比镜像体积
docker images | grep cms-

# 单独构建某个镜像
docker build -t cms-backend:local ./server
docker build -t cms-frontend:local ./web
```

注意：`docker-compose.build.yml` 打出的标签是 `:local`，**不会**覆盖线上拉取的 `:latest` 镜像；
正式发布仍走 push 到 `main` 触发 GitHub Actions。
