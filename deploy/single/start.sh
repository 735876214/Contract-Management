#!/usr/bin/env bash
# 必须用 bash：node:20-slim 的 /bin/sh 指向 dash，不支持 `wait -n`，
# 之前用 #!/bin/sh 会导致脚本启动即因 "Illegal option -n" 报错退出，容器起不来。
set -e

cd /app/server

# 1) 数据库结构同步（PostgreSQL，应用 migrations 目录下的迁移；空库则自动建表）
./node_modules/.bin/prisma generate
./node_modules/.bin/prisma migrate deploy

# 2) 确保上传目录存在（给默认值，避免环境变量缺失时 mkdir 空串报错）
mkdir -p "${UPLOAD_DIR:-/data/uploads}"

# 3) 后端后台启动
node dist/src/main &
NODE_PID=$!

# 4) nginx 前台托管前端 + 反代 /api（作为容器存活锚点）
/usr/sbin/nginx -g 'daemon off;' &
NGINX_PID=$!

stop_all() {
  kill -TERM "$NODE_PID" "$NGINX_PID" 2>/dev/null || true
}

# 收到停止信号：优雅退出（143 = 128 + SIGTERM），不会被 restart 策略视为异常崩溃
trap 'stop_all; exit 143' INT TERM

# 任一进程退出则整体退出，交由 restart 策略自愈
# 用 `|| STATUS=$?` 而不是裸 wait：set -e 下 wait 返回非 0 会直接终止脚本，
# 导致下面的 stop_all 收不到尾、子进程被留在半死状态。
STATUS=0
wait -n "$NODE_PID" "$NGINX_PID" || STATUS=$?

stop_all
exit $(( STATUS == 0 ? 1 : STATUS ))
