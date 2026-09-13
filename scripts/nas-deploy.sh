#!/usr/bin/env bash
#
# NAS 部署脚本：构建时由 Docker 直接从 GitHub 私有仓库克隆源码（无需在 NAS 上放源码）。
# 因为 docker-compose.yml 的 build.context 已是私有 git 地址（含 GITHUB_TOKEN），
# 所以本脚本只需：校验 .env 里的 GITHUB_TOKEN -> docker compose up -d --build。
# 每次运行都会重新克隆 main 并构建，天然“每次从 GitHub 拉最新代码”。
#
# 用法（在放有 docker-compose.yml 的目录里运行）：
#   bash scripts/nas-deploy.sh
#
# 一次性准备：
#   cp .env.example .env
#   编辑 .env：填入 GITHUB_TOKEN（具有 repo 权限的 Personal Access Token，必填）。
#              JWT_SECRET / CMS_DATA 不填也能跑（compose 有内联默认值）。
#
set -euo pipefail

echo "==> 当前目录: $(pwd)"

# 1) .env 校验
if [ ! -f .env ]; then
  echo "!! 未找到 .env，已为你从 .env.example 复制一份。" >&2
  echo "!! 请先编辑 .env，填入 GITHUB_TOKEN（具有 repo 权限的 GitHub Personal Access Token），再重新运行。" >&2
  cp .env.example .env
  exit 1
fi

# 2) GITHUB_TOKEN 必须存在（私有仓库克隆需要）
if ! grep -qE '^GITHUB_TOKEN=.+' .env; then
  echo "!! .env 里没有设置 GITHUB_TOKEN（或为空）。私有仓库克隆需要它（repo 权限的 PAT）。" >&2
  echo "!! 请编辑 .env 填入后重新运行；或把 GitHub 仓库设为 Public 并删掉 compose 里的 x-access-token 部分。" >&2
  exit 1
fi

# 3) 拉取最新代码并构建（构建上下文即远程 git 仓库，自动克隆 main）
echo "==> [1/3] 用 GitHub 最新源码构建并启动 (docker compose up -d --build)"
docker compose up -d --build

echo "==> [2/3] 等待 5s 查看容器状态"
sleep 5
docker compose ps

echo "==> [3/3] 清理悬空镜像 (docker image prune -f)"
docker image prune -f || true

echo ""
echo "==> 完成。访问 http://<NAS_IP>:8080 ，并由 NAS 反向代理加 HTTPS。"
echo "==> 更新：重新运行 bash scripts/nas-deploy.sh 即可拉取 GitHub 最新代码并重建。"
