#!/usr/bin/env bash
#
# NAS 部署脚本：从 GitHub Container Registry（ghcr.io）拉取最新预构建镜像并启动。
# 由于镜像已由 GitHub Actions 在 push 到 main 时自动构建并推送到 ghcr.io，
# NAS 上【无需源码】，直接 pull 即可（首次部署也是从 ghcr.io 拉，不会因缺构建上下文而失败）。
#
# 用法（在放有 docker-compose.yml 的目录里运行）：
#   bash scripts/nas-deploy.sh
#
# 前提（一次性）：
#   - NAS 的 Registry 里已添加 ghcr.io 登录凭据（账号=GitHub 用户名，
#     密码=具有 read:packages 权限的 Personal Access Token）。否则 pull 私有镜像会被拒。
#   - 若想换更强的 JWT 密钥，先 `cp .env.example .env` 并设 JWT_SECRET（不设也能跑，用内联默认值）。
#
# 本地构建模式（可选，需 NAS 上有源码）：
#   CMS_BUILD=local bash scripts/nas-deploy.sh   # 走 git clone/pull + 本地 docker compose build
#
set -euo pipefail

echo "==> 当前目录: $(pwd)"

if [ "${CMS_BUILD:-}" = "local" ]; then
  # ---- 本地构建模式：需要先有源码 ----
  REPO="${CMS_REPO:-https://github.com/735876214/Contract-Management.git}"
  CLONE_URL="$REPO"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/735876214/Contract-Management.git"
    git config credential.helper store
  fi
  if [ ! -d .git ]; then
    if [ -f docker-compose.yml ] || [ -d server ] || [ -d web ]; then
      echo "!! 当前目录含旧文件但不是 git 仓库，无法安全 clone。" >&2
      exit 1
    fi
    echo "==> [local] 首次：从 GitHub 克隆源码"
    git clone "$CLONE_URL" .
    [ -n "${GITHUB_TOKEN:-}" ] && git remote set-url origin "https://github.com/735876214/Contract-Management.git"
  fi
  echo "==> [local] 拉取最新代码"
  git pull origin main
  [ ! -f .env ] && cp .env.example .env
  echo "==> [local] 用最新源码本地构建并启动"
  docker compose up -d --build
else
  # ---- 默认：从 ghcr.io 拉预构建镜像（无需源码） ----
  [ ! -f .env ] && cp .env.example .env
  echo "==> [1/4] 从 ghcr.io 拉取最新镜像 (docker compose pull)"
  docker compose pull
  echo "==> [2/4] 启动 (docker compose up -d)"
  docker compose up -d
fi

echo "==> [3/4] 等待 5s 查看容器状态"
sleep 5
docker compose ps

echo "==> [4/4] 清理悬空镜像 (docker image prune -f)"
docker image prune -f || true

echo ""
echo "==> 完成。访问 http://<NAS_IP>:8080 ，并由 NAS 反向代理加 HTTPS。"
echo "==> 更新：重新运行 bash scripts/nas-deploy.sh 即可拉取 ghcr.io 上的最新镜像。"
