# 企业合同管理系统（CMS）

React 18 + TypeScript + Vite + Ant Design 5 + Zustand 前端，NestJS + Prisma + **PostgreSQL 16（唯一数据库）** 后端，JWT + RBAC 鉴权。

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

> **依赖管理统一使用 `npm`**（锁文件 `server/package-lock.json`、`web/package-lock.json` 已入库）。
> 2026-10 起从 pnpm 收敛为 npm：镜像（`deploy/single/Dockerfile.single`）与 CI 一直用 npm 安装，
> 而当时**没有提交 npm 锁文件**（旧 `.gitignore` 反而排除了它）→ 构建不可复现；且 `pnpm-lock.yaml`
> 已过期（`package.json` 09-17 改过、锁文件停在 09-14）。pnpm 在镜像内曾评估并放弃
> （符号链接跨构建阶段 COPY 易踩坑），故统一到 npm 一侧。
> 安装命令统一带 `--legacy-peer-deps`（与镜像/CI 完全一致）：`npm ci --legacy-peer-deps`。

```bash
# 1. 方式 A · 容器化一键调试（推荐：前后端源码挂载 + 热重载 + PostgreSQL）
docker compose -f docker-compose.dev.yml up
#    前端 http://localhost:5173（vite HMR），后端 API http://localhost:3000/api，
#    PostgreSQL 映射到本机 15432，上传文件落在 ./data-dev；首次启动会安装依赖（约几分钟）。

# 1. 方式 B · 宿主机直跑（习惯 IDE 调试时用）
docker compose -f docker-compose.dev.yml up -d postgres   # PostgreSQL → 本机 15432

# 2. 后端（NestJS）
cd server
cp .env.example .env                    # 把 DATABASE_URL 的端口改成 15432
npm ci --legacy-peer-deps               # 按锁文件安装依赖（可复现）
npx prisma migrate deploy               # 空库一次建全表（含折叠基线 20260901000000_init）
npm run seed                            # 初始化字典 / 角色 / 演示数据
npm run start:dev                       # http://localhost:3000/api

# 3. 前端（React）
cd ../web
npm ci --legacy-peer-deps
npm run dev                             # http://localhost:5173（/api 反代到 localhost:3000）
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
    ├── contract/      合同 CRUD、编号查重、签章、变更留痕
    ├── template/      模板库、版本、条款库、生成向导
    ├── daily-report/  日报（物资种类按材料类别联动）
    ├── contract-item/ 合同清单
    ├── settlement/    结算单 + 结算台账
    ├── payment/       付款台账（只登记已完成付款）+ 逾期利息
    ├── invoice/       收票登记、查重、二维码/OCR 识别、查验（登记核对，不做验真）
    ├── ledger/        合同台账（聚合视图 + 合规性问题计算）
    ├── repayment/     还款协议 + 还款明细
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
- **依赖安装**：项目统一使用 **`npm` + `--legacy-peer-deps`**（`npm ci --legacy-peer-deps` 最接近镜像/CI 行为）。
  锁文件 `server/package-lock.json`、`web/package-lock.json` **必须随 `package.json` 一起提交**——
  镜像与 CI 走 `npm ci`，缺锁文件会直接失败。改了依赖后请在对应目录跑
  `npm install --package-lock-only --legacy-peer-deps` 刷新锁文件。
- **npm 提示「install scripts not yet covered by allowScripts」**：npm 11 起的告警，
  prisma / esbuild 等确需构建脚本，可忽略（镜像内的 npm 10 不做拦截）。
- **上传目录与对象存储**：默认落 `server/uploads`，由 `/api/files/**` 静态映射；
  **落盘统一走 `server/src/common/services/storage.service.ts`（`StorageService`）**——换 MinIO/S3 只需
  实现同一个 `StorageLike`、改 `common.module.ts` 的 provider 绑定，再把 `main.ts` 的静态服务改成
  代理/302 重定向即可，调用方不用动。

更多说明见 `docs/` 目录。

## Docker 部署

镜像由 GitHub Actions 在 push 到 `main`（或打 `v*` 标签）时自动构建并推送到 `ghcr.io/735876214/cms-single`
（公开，NAS 上无需源码 / 构建即可拉取）；每次推送同时产出 `latest` 与 `sha-<commit sha>` 两种 tag。

`docker-compose.yml` 是**唯一的部署入口**：前后端合并为**一个**容器（内部 nginx 托管前端并把 `/api` 反代到同容器
`127.0.0.1:3000`），对外只暴露一个端口，减少资源占用与容器数量，降低长时间运行被自动终止的概率。

```bash
# 部署前先编辑 docker-compose.yml（配置直接写在 compose 里，不用 .env）：
#   ① postgres / cms 两个服务的 volumes：改成 NAS 实际路径（「← NAS 路径」标注处，
#      如 /volume1/docker/cms/pgdata 与 /volume1/docker/cms/data）
#   ② JWT_SECRET：openssl rand -base64 48 生成随机值替换占位串
docker compose up -d
```

对外端口 `9080`（被占用就改 compose 里 ports 左侧）；PostgreSQL 数据与上传附件分别落在
compose 里指定的两个 NAS 绝对路径（bind mount，NAS 文件管理器直接可见、可纳入 NAS 备份计划），
容器重建不丢数据。
容器设置 `restart: unless-stopped`、`healthcheck`、`init: true`，被平台回收后会自动重启并正确回收僵尸进程。

首次启动（空库）会自动创建默认管理员（compose 里 `DEFAULT_ADMIN_USERNAME/PASSWORD`，默认 `admin`/`admin123`）、默认项目
以及字典 / 系统参数，装好后请立即修改密码；已有数据则跳过，重复启动安全。

### 手动更新

更新是**手动触发**的（有意不做 Watchtower / NAS 计划任务自动更新——升级前可以看一眼变更、先备份）：

```bash
docker compose pull && docker compose up -d     # 升级前建议先跑一次备份（见下节）
```

数据库结构由新镜像内的 `prisma migrate deploy` 在启动时自动叠加，无需手工迁移。

备份与恢复见下文「[备份与恢复](#备份与恢复2026-10-17-起已演练验证)」（`scripts/backup.sh` 每日 cron +
硬链接增量；恢复 `scripts/restore.sh <日期>`）——**升级前建议先跑一次备份**。

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

## 备份与恢复（2026-10-17 起，已演练验证）

**每天一次**：首次全量、之后**硬链接增量**（rsync `--link-dest`，未变文件是到前一日的硬链接，不占额外空间），
**保留 7 天**滚动清理。范围 = **PostgreSQL 数据库**（`pg_dump -Fc` 自定义格式）+ **上传附件**（docker-compose.yml 里 cms 服务挂载的 NAS 路径，默认 `${CMS_DIR}/data`，可用环境变量 `DATA_DIR` 覆盖）。

### 产物结构

```
backups/
├── db/<YYYY-MM-DD>/cms.dump     # 数据库（pg_restore 恢复）
├── files/<YYYY-MM-DD>/...       # 附件快照（恢复 = 直接拷贝该目录）
└── backup.log                   # 运行日志（cron 重定向追加）
```

### 配置每日定时（Linux/NAS 宿主机）

```bash
crontab -e
# 每天 02:30 备份（容器名/路径可用环境变量覆盖，见脚本头注释）
30 2 * * * CMS_DIR=/path/to/Contract-Management /path/to/Contract-Management/scripts/backup.sh >> /path/to/Contract-Management/backups/backup.log 2>&1
```

- 脚本幂等：同一天重复跑会覆盖当天产物；postgres 容器名不匹配时自动按名字兜底查找。
- **NAS 计划任务注意**：用绝对路径，不依赖工作目录；脚本只依赖 `bash / docker / rsync`。
- 首次运行（无前一日目录）自动为全量；`RETAIN_DAYS=7` 可改，目录数 < 2 时**不会**执行清理（防呆）。

### 恢复（与备份同一入口演练过）

```bash
scripts/restore.sh 2026-10-17            # 交互确认后 pg_restore --clean 覆盖 + 附件目录还原
scripts/restore.sh 2026-10-17 --drop     # 演练模式：先 DROP 重建再重放（会断开现有连接）
scripts/restore.sh 2026-10-17 --yes      # 跳过交互确认（自动化）
```

> 生产恢复前**先停后端容器**（`docker compose stop cms`）避免恢复期间写入；恢复完 `docker compose start cms`。

### 演练记录

- **2026-10-17 本机全流程演练通过**（alpine 容器内跑同一脚本，连 dev 库 cms）：
  ① 首日全量（db 352K + 附件 2 文件）；② 次日增量——改 1 文件 + 新增 1 文件后重跑，
  「新建 3 个（硬链接复用 1 个）」，`find -links +1` 验证硬链接成立；
  ③ 插入脏数据后 `restore.sh --drop` 回滚——脏数据消失、users=3 冒烟通过；
  ④ 手工造 10 天前的过期目录再跑——「清理 2 个过期目录」，最近备份保留。
