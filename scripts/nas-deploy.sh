#!/usr/bin/env bash
#
# NAS 部署脚本：ghcr.io 镜像已设为 PUBLIC，直接 pull + up。
# 无需在 NAS 上放源码、无需 GITHUB_TOKEN、无需本地构建。
# 每次运行都会因 compose 的 pull_policy: always 拉取 GitHub Actions 最新构建推送的镜像，
# 天然满足“每次从 GitHub 拉最新代码”（Actions 在 push 到 main 时自动重建并推送镜像）。
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
