# 2026-10-21 NAS 升级记录（CMS 0b86cb8）

## 结论

线上 `cms` 已从旧镜像（revision `130d8ac9`，2026-10-18 构建）升级到最新代码 `0b86cb8`，
数据库 33 个迁移全部到位（本次新增 5 个），业务数据未动。

## 宿主侧事实（极空间 Z4 Pro）

| 项 | 值 |
| --- | --- |
| compose 项目名 | `cms-backend` |
| compose 文件 | `/tmp/zfsv3/nvme13/13573503798a/data/Docker/CMS/docker-compose.yml` |
| 容器 | `cms`（对外 `9080:8080`）、`cms-postgres`（不对外） |
| 网络 | `cms-backend_default` |
| 上传目录 | `/tmp/zfsv3/nvme13/13573503798a/data/Docker/CMS/data` → 容器 `/data` |
| 数据库目录 | `/tmp/zfsv3/nvme13/13573503798a/data/Docker/CMS/pgdata` → 容器 `/var/lib/postgresql/data` |

> DSH 容器里的 docker CLI 每次重建都会丢，重装：`bash scripts/dsh-docker-bootstrap.sh`。
> 宿主文件从这个容器里看不直接可见，读写靠一次性容器挂载：`docker run --rm -v <宿主目录>:/w ...`。

## 本次做的三件事

1. **救活僵尸部署**：升级前 `cms` / `cms-postgres` 状态是 `Up` 但 `docker exec` / healthcheck 全部报
   `NotFound: task ... not found`，9080 连接被 RST，日志里 Prisma 报 `P1001`（连不上库）——
   容器进程实际已死，只是 daemon 还显示 Up。`docker restart` 两个容器后恢复。
2. **换镜像**：按最新代码本地构建 `ghcr.io/735876214/cms-single:latest`
   （`docker build -f deploy/single/Dockerfile.single .`，产物 `ea4da13aac96`，461MB）。
   旧镜像保留为 `ghcr.io/735876214/cms-single:rollback-20261018`（`32010fa731ae`）。
3. **补 JWT_SECRET**：新代码在 `JwtStrategy` 里 fail-fast——`JWT_SECRET` 缺省或以 `change-me` 开头
   直接抛错拒绝启动。旧部署用的正是占位值 `change-me-openssl-rand-base64-48`，
   所以第一次重建后容器 crash-loop。已用 `crypto.randomBytes(48)` 生成随机值写回宿主 compose。
   **副作用：所有旧登录态失效，用户需重新登录。**

## 备份（在 DSH 工作区）

- `backups/cms-db-20261021.sql.gz` —— 升级前 `pg_dump`（35KB）
- `backups/cms-storage-20261021.tar.gz` —— `pgdata` + `data` + compose 原始文件（7.5MB）
- `backups/deploy-state/containers-20261021.json` —— 升级前两容器的完整 `docker inspect`
- 宿主处另有 `docker-compose.yml.bak-20261021`（改动前的 compose）

## 回滚

```bash
# 1) 把 compose 里的 image 换回 rollback 标签，或直接：
docker tag ghcr.io/735876214/cms-single:rollback-20261018 ghcr.io/735876214/cms-single:latest
docker compose -p cms-backend \
  --project-directory /tmp/zfsv3/nvme13/13573503798a/data/Docker/CMS \
  -f /workspace/Contract-Management/deploy/nas/docker-compose.yml \
  up -d --no-deps --force-recreate cms
# 2) 库结构如需回退：先停 cms，再恢复 dump（注意新迁移已应用，理论上向后兼容旧镜像）
```

⚠ 回滚到旧镜像时，compose 里的新 JWT_SECRET 仍可用（旧代码不校验），用户会保持登录态。

## 以后更新流程

```bash
cd /workspace/Contract-Management && git pull --ff-only
docker build -f deploy/single/Dockerfile.single -t ghcr.io/735876214/cms-single:latest .
export HOSTDIR=/tmp/zfsv3/nvme13/13573503798a/data/Docker/CMS
docker compose -p cms-backend --project-directory "$HOSTDIR" \
  -f /workspace/Contract-Management/deploy/nas/docker-compose.yml \
  up -d --no-deps --force-recreate cms
```

`deploy/nas/docker-compose.yml` 是宿主 compose 的逐字节副本（改一处要同步另一处），
用于在 DSH 容器里驱动 `cms-backend` 项目。

## 待办（安全）

- `DEFAULT_ADMIN_PASSWORD` 仍是 `admin123`，管理员账号密码未改 → 建议尽快在系统里改。
- `POSTGRES_PASSWORD` 仍是 `cms123456`（库不对外，风险有限）。
