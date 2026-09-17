# 企业合同管理系统（CMS）

React 18 + TypeScript + Vite + Ant Design 5 + Zustand 前端，NestJS + Prisma + PostgreSQL 后端，JWT + RBAC 鉴权。

## 目录结构

```
cms/
├── docker-compose.yml        # PostgreSQL 数据库
├── docs/
│   ├── 01-需求确认摘要.md
│   ├── 02-数据库ER设计.md
│   └── 03-API接口清单.md
├── server/                   # NestJS 后端
│   ├── prisma/schema.prisma  # 全量数据模型
│   ├── prisma/seed.ts        # 初始化字典/角色/演示数据
│   └── src/modules/...       # 15 大业务模块
└── web/                      # React 前端
    └── src/...
```

## 快速开始

> 项目使用 **pnpm**（lockfile 为 v9）。`server/package.json` 与 `web/package.json` 已通过 `packageManager` 字段锁定 pnpm 版本，启用 corepack 后会自动选用；构建脚本（prisma / @nestjs/core / esbuild）已在各目录的 `pnpm-workspace.yaml` 中放行，普通 `pnpm install` 即可完成依赖与构建。

```bash
# 0. （可选）启用包管理器版本管理
corepack enable && corepack prepare pnpm@12 --activate

# 1. 方式 A · 容器化一键调试（推荐：前后端源码挂载 + 热重载 + PostgreSQL）
docker compose -f docker-compose.dev.yml up
#    前端 http://localhost:5173（vite HMR），后端 API http://localhost:3000/api，
#    PostgreSQL 映射到本机 15432，上传文件落在 ./data-dev；首次启动会安装依赖（约几分钟）。

# 1. 方式 B · 宿主机直跑（习惯 IDE 调试时用）
docker compose -f docker-compose.dev.yml up -d postgres   # PostgreSQL → 本机 15432

# 2. 后端（NestJS）
cd server
cp .env.example .env       # 把 DATABASE_URL 的端口改成 15432
pnpm install               # 安装依赖（构建脚本已在 pnpm-workspace.yaml 中放行）
npx prisma migrate deploy  # 空库一次建全表（含折叠基线 20260901000000_init）
pnpm run seed              # 初始化字典 / 角色 / 演示数据
pnpm run start:dev         # http://localhost:3000/api

# 3. 前端（React）
cd ../web
pnpm install
pnpm run dev               # http://localhost:5173（/api 反代到 localhost:3000）
```

> 改了 `server/prisma/schema.prisma` 之后，用 `npx prisma migrate dev --name xxx` 生成迁移文件。
> **不要用 `prisma db push`**：它会让本机库脱离迁移历史，缺失的迁移只在别人或生产上暴露。

> 注意：`node_modules/`、`*.db`、`uploads/`、`.env` 等均已在 `.gitignore` 中忽略，请勿提交。

默认账号：`admin / admin123`（超级管理员，拥有全部项目权限）；另有 `manager`、`staff` 演示账号（密码相同）。

## 目录结构说明

```
server/src/
├── common/            通用层：统一响应、异常过滤、装饰器、Excel、日志、系统参数
├── prisma/            全局 PrismaClient
└── modules/
    ├── auth/          JWT 登录、RBAC 权限守卫
    ├── dict/          字典类型/字典项、缓存、引用校验、导入导出
    ├── project/       项目管理与项目成员
    ├── supplier/      供应商库（合同创建自动带出）
    ├── contract/      合同 CRUD、编号查重、审批、变更留痕
    ├── template/      模板库、版本、条款库、生成向导
    ├── daily-report/  日报（物资种类按材料类别联动）
    ├── contract-item/ 合同清单
    ├── settlement/    结算单 + 结算台账
    ├── payment/       付款计划/申请/执行台账/核销/逾期
    ├── invoice/       收票登记、开票申请、查重查重、查验预留
    ├── ledger/        合同台账（聚合视图 + 合规性问题计算）
    ├── repayment/     还款协议 + 还款明细
    ├── approval/      审批流定义与审批中心
    ├── notification/  站内信（邮件/短信/企微接口预留）
    ├── dashboard/     看板统计
    └── system/        用户/角色/权限/部门/参数/日志
```

## 核心约定

- **接口统一返回** `{ code, data, message }`，`code = 0` 表示成功。
- **项目隔离**：前端通过请求头 `x-project-id` 传递当前项目，后端所有业务数据强制按 `projectId` 过滤。
- **字典驱动**：所有下拉/单选/复选与标签颜色来自 `dict_type` / `dict_item`，后端字典服务带内存缓存，变更后自动刷新。
- **供应商信息不冗余**：合同仅存 `supplierId`，法人/授权人/联系人/银行等信息由供应商库实时关联。

## 常见问题

- **Prisma 引擎下载慢/失败**：`npx prisma generate` 需要从网络下载查询引擎，若失败可配置镜像
  `PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma` 后重试。
- **依赖安装**：项目统一使用 `pnpm`（不要用 `npm`，否则会生成被 `.gitignore` 排除的 `package-lock.json`）。`pnpm install` 若提示构建脚本被拦截，确认对应目录 `pnpm-workspace.yaml` 中的 `allowBuilds` 已放行（prisma / @nestjs/core / esbuild）。
- **上传目录**：默认 `server/uploads`，由 `/api/files/**` 静态映射，生产环境建议替换为对象存储
  （`FileController` 是唯一的写入点，替换实现即可）。
- **MySQL 差异**：本模型使用 `Decimal(18,2)` 与 `String` 字典编码，MySQL 下同样适用；
  差异在于 Postgres 支持 `@@unique` 中 nullable 列的多空值（MySQL 允许多个 NULL，语义一致），
  若切换到 MySQL 需把 `@db.Text` 长文本字段改为 `@db.Text`（MySQL 支持）或 `String` 并指定长度。

更多说明见 `docs/` 目录。

## Docker 部署

镜像由 GitHub Actions 在 push 到 `main`（或打 `v*` 标签）时自动构建并推送到 `ghcr.io/735876214/cms-single`
（公开，NAS 上无需源码 / 构建即可拉取）；每次推送同时产出 `latest` 与 `sha-<commit sha>` 两种 tag。

`docker-compose.yml` 是**唯一的部署入口**：前后端合并为**一个**容器（内部 nginx 托管前端并把 `/api` 反代到同容器
`127.0.0.1:3000`），对外只暴露一个端口，减少资源占用与容器数量，降低长时间运行被自动终止的概率。

```bash
cp .env.example .env        # 必填 JWT_SECRET（openssl rand -base64 48），可选改端口 / 数据目录 / 初始管理员
docker compose up -d        # 直接拉公开镜像启动，每次启动都会拉最新镜像
```

对外端口 `${CMS_HTTP_PORT:-9080}`；上传文件落在 `${CMS_DATA:-./data}`（NAS 建议改成绝对路径），数据库由 compose 内的 postgres 服务独立持久化（命名卷 pgdata），
bind mount 到容器 `/data`，容器重建不丢数据。
容器设置 `restart: unless-stopped`、`healthcheck`、`init: true`，被平台回收后会自动重启并正确回收僵尸进程。

首次启动（空库）会自动创建默认管理员（`DEFAULT_ADMIN_USERNAME/PASSWORD`，默认 `admin`/`admin123`）、默认项目
以及字典 / 系统参数，装好后请立即修改密码；已有数据则跳过，重复启动安全。

数据库结构由 `server/prisma/migrations` 管理：`20260901000000_init` 是「空库 → 当前 schema」的**折叠基线**，
空库首次启动 `prisma migrate deploy` 一次建全表；之后的新迁移按时间戳顺序叠加。

> **从 2026-09-17 之前的旧版本升级（NAS 等已有库）必读**：旧版本的 11 条增量迁移已折叠进 init 并删除，
> 旧库 `_prisma_migrations` 里记录的还是这些已删除的迁移，升级前需先标记基线（只写一条迁移记录，不动数据）：
>
> ```bash
> docker cp ./server/prisma/migrations/20260901000000_init cms:/app/server/prisma/migrations/
> docker exec cms sh -c "cd /app/server && ./node_modules/.bin/prisma migrate resolve --applied 20260901000000_init"
> ```
> 之后再拉新镜像重启即可（已实测：库中残留的旧迁移记录不会影响 `migrate deploy`）。

本地构建（镜像不可访问时的兜底，仓库根目录执行；compose 已内置 `build:` 段）：

```bash
docker compose up -d --build    # 构建并启动，产出同一个 ghcr.io/735876214/cms-single:latest tag
```

内部 `start.sh` 让后端与 nginx 任一进程退出即整体退出，由重启策略自愈。
