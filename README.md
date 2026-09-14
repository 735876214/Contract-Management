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

# 1. 准备数据库（二选一）
#    方式 A · PostgreSQL（推荐，功能完整，需 Docker）
cd cms && docker compose up -d
#    方式 B · SQLite（本地快速体验，无需 Docker；.env 已默认 DATABASE_URL="file:./dev.db"）
cd server && pnpm run demo:sqlite   # 自动生成 SQLite schema、建表、生成 Prisma Client 并写入种子数据

# 2. 后端
cd server
cp .env.example .env        # 已有 .env（指向 dev.db）可跳过；PostgreSQL 方式请改 DATABASE_URL
pnpm install                # 安装依赖（构建脚本已在 pnpm-workspace.yaml 中放行）
npx prisma generate --schema prisma/schema.sqlite.prisma   # SQLite 本地开发
# 使用 PostgreSQL 时改为：npx prisma generate && npx prisma migrate deploy
pnpm run seed               # 初始化字典 / 角色 / 演示数据（PostgreSQL 方式；SQLite 已由 demo:sqlite 完成）
pnpm run start:dev         # http://localhost:3000/api

# 3. 前端
cd ../web
pnpm install
pnpm run dev               # http://localhost:5173
```

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

镜像由 GitHub Actions 在 push 到 `main` 时自动构建并推送到 `ghcr.io/735876214/cms-single`（公开，NAS 上无需源码 / 构建即可拉取）。

`docker-compose.yml` 是**唯一的部署入口**：前后端合并为**一个**容器（内部 nginx 托管前端并把 `/api` 反代到同容器
`127.0.0.1:3000`），对外只暴露一个端口，减少资源占用与容器数量，降低长时间运行被自动终止的概率。

```bash
docker compose up -d        # 直接拉公开镜像启动，每次启动都会拉最新镜像
```

对外端口 `${CMS_HTTP_PORT:-9080}`；数据（SQLite + 上传文件）bind mount 到 `/data`，容器重建不丢数据。
容器设置 `restart: unless-stopped`、`healthcheck`、`init: true`，被平台回收后会自动重启并正确回收僵尸进程。

本地验证可自行构建：

```bash
docker build -f deploy/single/Dockerfile.single -t cms-single:local .
# 然后把 compose 内 image 改为 cms-single:local、注释掉 pull_policy 再 up -d
```

内部 `start.sh` 让后端与 nginx 任一进程退出即整体退出，由重启策略自愈。
