#!/usr/bin/env bash
#
# NAS 部署更新脚本（从 GitHub 拉取最新代码并重建容器）
# 适用：已在 NAS 上 git clone 过 CMS 仓库，目录内含 docker-compose.yml / server / web。
# 用法：
#   bash scripts/nas-deploy.sh
#
# 它做的事：
#   1. 若 .env 不存在则从 .env.example 复制（compose 已内联默认值，不覆盖也能跑）
#   2. git pull origin main           —— 拉取 GitHub 最新代码
#   3. docker compose up -d --build   —— 用最新代码重建并启动 backend + frontend
#   4. 等待并 docker compose ps 查看状态
#   5. 清理悬空镜像（可选，失败不阻断）
#
set -euo pipefail

# 切到仓库根目录（脚本位于 <repo>/scripts/ 下）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
echo "==> 仓库根目录: $(pwd)"

# 1) .env 可选：缺失时从示例复制（compose 已内联默认值，复制后不编辑也能直接跑）
if [ ! -f .env ]; then
  echo "== 未找到 .env，已从 .env.example 复制（compose 内联默认值，无需修改即可运行）。"
  echo "== 如需覆盖 JWT_SECRET / CMS_DATA，编辑 .env 取消对应注释并填入实际值即可。"
  cp .env.example .env
fi

# 2) 拉取 GitHub 最新代码
echo "==> [1/4] 拉取 GitHub 最新代码 (git pull origin main)"
git pull origin main

# 3) 重新构建并启动
echo "==> [2/4] 用最新代码重建并启动容器 (docker compose up -d --build)"
docker compose up -d --build

# 4) 查看状态
echo "==> [3/4] 等待 5s 后查看容器状态"
sleep 5
docker compose ps

# 5) 清理悬空镜像（可选）
echo "==> [4/4] 清理悬空镜像（docker image prune -f）"
docker image prune -f || true

echo ""
echo "==> 部署完成。访问 http://<NAS_IP>:8080 ，并由 NAS 反向代理加 HTTPS。"
echo "==> 若需回滚：git log --oneline 找到上一提交，git checkout <旧commit>，再 bash scripts/nas-deploy.sh"
