#!/usr/bin/env bash
#
# NAS 部署脚本：首次与更新都「从 GitHub 拉取最新代码」后本地构建。
# 在部署目录下运行：
#   bash scripts/nas-deploy.sh            # 目录无 .git 时自动 clone；已有则自动 pull
#
# 首次一键（在任意空目录执行，私有仓库用 token）：
#   GITHUB_TOKEN=xxxx git clone https://x-access-token:xxxx@github.com/735876214/Contract-Management.git CMS \
#     && cd CMS && bash scripts/nas-deploy.sh
#
# 私有仓库认证（二选一，设好再跑）：
#   export GITHUB_TOKEN=ghp_xxx            # Personal Access Token（HTTPS，脚本克隆后会清除 remote 中的 token）
#   export CMS_REPO=git@github.com:735876214/Contract-Management.git   # 或 SSH 部署密钥
#
set -euo pipefail

REPO="${CMS_REPO:-https://github.com/735876214/Contract-Management.git}"
CLONE_URL="$REPO"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/735876214/Contract-Management.git"
  git config credential.helper store   # 克隆成功后缓存凭据，便于后续 git pull
fi

echo "==> 当前目录: $(pwd)"

# 1) 首次：若不是 git 仓库则克隆
if [ ! -d .git ]; then
  if [ -f docker-compose.yml ] || [ -d server ] || [ -d web ]; then
    echo "!! 当前目录含旧文件但不是 git 仓库，无法安全 clone 到此处。" >&2
    echo "!! 请在一个空目录运行，或先手动 'git clone $REPO .' 初始化。" >&2
    exit 1
  fi
  echo "==> [0/5] 首次部署：从 GitHub 克隆仓库"
  git clone "$CLONE_URL" .
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    # 清除 remote 中残留的 token，凭据已由 credential.helper 缓存
    git remote set-url origin "https://github.com/735876214/Contract-Management.git"
  fi
fi

# 2) 拉取 GitHub 最新代码（首次克隆后此步幂等，已是最新则无操作）
echo "==> [1/5] 拉取 GitHub 最新代码 (git pull origin main)"
git pull origin main

# 3) .env 可选：缺失时从示例复制（compose 已内联默认值，不编辑也能跑）
if [ ! -f .env ]; then
  echo "== 未找到 .env，已从 .env.example 复制（compose 内联默认值，无需修改即可运行）。"
  cp .env.example .env
fi

# 4) 用最新代码重建并启动
echo "==> [2/5] 用最新代码重建并启动 (docker compose up -d --build)"
docker compose up -d --build

# 5) 查看状态
echo "==> [3/5] 等待 5s 查看容器状态"
sleep 5
docker compose ps

# 6) 清理悬空镜像（可选，失败不阻断）
echo "==> [4/5] 清理悬空镜像 (docker image prune -f)"
docker image prune -f || true

echo ""
echo "==> [5/5] 完成。访问 http://<NAS_IP>:8080 ，并由 NAS 反向代理加 HTTPS。"
echo "==> 回滚：git log --oneline 找上一提交；git checkout <旧commit>；再 bash scripts/nas-deploy.sh"
