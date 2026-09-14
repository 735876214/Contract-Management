#!/bin/sh
set -e

cd /app/server

# 1) 同步 schema 到 SQLite（DATABASE_URL 指向挂载卷里的文件）
./node_modules/.bin/prisma db push --schema prisma/schema.sqlite.prisma --skip-generate

# 2) 确保上传目录存在（给默认值，避免环境变量缺失时 mkdir 空串报错）
mkdir -p "${UPLOAD_DIR:-/data/uploads}"

# 3) 后端后台启动
node dist/src/main &
NODE_PID=$!

# 4) nginx 前台托管前端 + 反代 /api（作为容器存活锚点）
/usr/sbin/nginx -g 'daemon off;' &
NGINX_PID=$!

# 任一进程退出则整体退出，交由 restart 策略自愈
trap 'kill -TERM $NODE_PID $NGINX_PID 2>/dev/null' EXIT INT TERM
wait -n
kill -TERM $NODE_PID $NGINX_PID 2>/dev/null
exit 1
