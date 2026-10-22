#!/usr/bin/env bash
# 在 DSH 容器里重建 docker CLI —— 容器每次重建（如加挂 docker.sock 后重启）都会丢 /usr/local/bin/docker，
# 这个脚本从国内镜像装回来。镜像源实测：download.docker.com 直连/走代理都可能被掐断，阿里云镜像稳定；
# docker compose 插件走 ghfast.top 镜像（github 直连走代理会在大约 76MB 处截断）。
#
# 用法：bash scripts/dsh-docker-bootstrap.sh
set -euo pipefail

DOCKER_VER="${DOCKER_VER:-27.5.1}"
COMPOSE_VER="${COMPOSE_VER:-v2.40.1}"

if [ -x /usr/local/bin/docker ] && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "==> docker CLI 已就绪：$(docker --version)"
else
  echo "==> 安装 docker CLI ${DOCKER_VER}（阿里云镜像）"
  tmp="$(mktemp -d)"
  curl -sSL -m 300 -o "$tmp/docker.tgz" \
    "https://mirrors.aliyun.com/docker-ce/linux/static/stable/x86_64/docker-${DOCKER_VER}.tgz"
  tar xzf "$tmp/docker.tgz" -C "$tmp" docker/docker
  install -m755 "$tmp/docker/docker" /usr/local/bin/docker
  rm -rf "$tmp"
fi

mkdir -p /usr/local/lib/docker/cli-plugins
if docker compose version >/dev/null 2>&1; then
  echo "==> compose 插件已就绪：$(docker compose version)"
else
  echo "==> 安装 docker compose 插件 ${COMPOSE_VER}（ghfast 镜像）"
  curl -sSL --http1.1 -m 300 -o /usr/local/lib/docker/cli-plugins/docker-compose \
    "https://ghfast.top/https://github.com/docker/compose/releases/download/${COMPOSE_VER}/docker-compose-linux-x86_64"
  chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose
fi

echo "==> 校验"
docker --version
docker compose version
if docker ps --format '{{.Names}}' >/dev/null 2>&1; then
  echo "==> 已能连上宿主 docker（socket 正常）"
else
  echo "!! 连不上 docker，请确认容器启动参数里挂了 -v /var/run/docker.sock:/var/run/docker.sock" >&2
  exit 1
fi
