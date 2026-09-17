#!/usr/bin/env bash
#
# NAS 部署脚本：从 ghcr.io 拉镜像 + up，无需在 NAS 上放源码 / 本地构建。
#
# ⚠ 前提：cms-single 目前【不是公开包】，NAS 上首次必须先登录 ghcr.io：
#     docker login ghcr.io -u 735876214   # 密码填带 read:packages 的 PAT
#   （或者去 GitHub → Your packages → cms-single → Package settings 把包改为 Public，
#     之后就永远免登录。）
#
# pull 由脚本显式执行，因此 compose 里 pull_policy 已改为 missing：
# 本地已存在同名 tag（例如本机自己 --build 出来的）时不会被覆盖 / 触发鉴权失败。
# compose pull 总会拉远端最新 tag，满足“每次拿 GitHub Actions 最新构建产物”。
#
# 用法（在放有 docker-compose.yml 的目录里运行）：
#   bash scripts/nas-deploy.sh
#
# 一次性准备（可省，不准备 .env 也能跑）：
#   cp .env.example .env
#   按需编辑 JWT_SECRET / CMS_DATA（不填则用 compose 内联默认值）。
#
set -euo pipefail

echo "==> 当前目录: $(pwd)"

# 1) 拉取最新公开镜像并启动（pull_policy: always 已保证每次拉最新）
echo "==> [1/3] 拉取最新镜像并启动 (docker compose pull && up -d)"
docker compose pull
docker compose up -d

# 2) 等待并查看状态
echo "==> [2/3] 等待 5s 查看容器状态"
sleep 5
docker compose ps

# 3) 清理悬空镜像（可选，失败不阻断）
echo "==> [3/3] 清理悬空镜像 (docker image prune -f)"
docker image prune -f || true

echo ""
echo "==> 完成。访问 http://<NAS_IP>:8080 ，并由 NAS 反向代理加 HTTPS。"
echo "==> 更新：重新运行 bash scripts/nas-deploy.sh 即可拉取 GitHub 最新镜像并重建。"
