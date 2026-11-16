#!/usr/bin/env sh
# ============================================================================
# dev 容器僵尸进程巡检 / 清理
#
#   sh scripts/dev-zombie-check.sh            # 只巡检：退出码 0=干净，1=有僵尸
#   sh scripts/dev-zombie-check.sh --fix      # 巡检 + 重建 dev 容器（僵尸只能靠重建清掉）
#
# 为什么要这个脚本：容器里 PID1 若不是 init（docker-compose.dev.yml 里的 `init: true`），
# 就是应用自己（npm / npx / nest，都是 node 进程）。node 不回收「被别人过继来的」孤儿：
# 调试期间的短命进程（watch 热重启的旧进程、prisma schema-engine、IDE attach 残留、
# docker exec 里的临时命令）一旦生父先退出就被挂到 PID1 名下，退出后永远定格成 <defunct>。
# 僵尸进程 kill 不掉（Z 状态不占 CPU/内存，只占 PID 表槽位），唯一清法是重建容器。
#
# 注意：容器里通常没有 ps（node:slim / alpine 基础镜像），所以这里扫 /proc/<pid>/stat。
# /proc/<pid>/stat 的进程名可能带空格和括号，不能按空格切第 3 段；
# 正确做法是先砍掉到最后一个 ") " 之前的全部内容，剩下的第一个字段才是状态。
# ============================================================================
set -u

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.dev.yml}

case $0 in
  */*) SCRIPT_DIR=$(CDPATH= cd -- "${0%/*}" && pwd) ;;
  *)   SCRIPT_DIR=$(pwd) ;;
esac
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SELF=$SCRIPT_DIR/${0##*/}

if [ ! -f "$ROOT/$COMPOSE_FILE" ]; then
  echo "找不到 compose 文件：$ROOT/$COMPOSE_FILE" >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "找不到 docker 命令" >&2; exit 2; }

# 在容器内数 Z 状态进程数量
SCAN=$(cat <<'EOS'
n=0
for p in /proc/[0-9]*; do
  { read -r line < "$p/stat"; } 2>/dev/null || continue
  rest=${line##*) }
  state=${rest%% *}
  [ "$state" = Z ] && n=$((n + 1))
done
printf '%s\n' "$n"
EOS
)

zombies_in() {
  docker exec "$1" sh -c "$SCAN" 2>/dev/null || echo "-"
}

pid1_of() {
  docker exec "$1" sh -c 'tr "\0" " " < /proc/1/cmdline' 2>/dev/null | cut -c1-60
}

containers=$(cd "$ROOT" && docker compose -f "$COMPOSE_FILE" ps --all --format '{{.Name}}' 2>/dev/null)

if [ -z "$containers" ]; then
  echo "dev 栈当前没有容器（先 docker compose -f $COMPOSE_FILE up -d）"
  exit 0
fi

total=0
dirty=0
printf '%-22s %-10s %-6s %-7s %s\n' CONTAINER STATE INIT ZOMBIES PID1
for c in $containers; do
  state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo unknown)
  init=$(docker inspect -f '{{.HostConfig.Init}}' "$c" 2>/dev/null || echo '?')
  if [ "$state" = "running" ]; then
    z=$(zombies_in "$c")
    p1=$(pid1_of "$c")
  else
    z="-"
    p1="-"
  fi
  printf '%-22s %-10s %-6s %-7s %s\n' "$c" "$state" "$init" "$z" "$p1"
  case $z in
    ''|'-'|*[!0-9]*) : ;;
    *) total=$((total + z)); [ "$z" -gt 0 ] && dirty=1 ;;
  esac
done

echo
if [ "$dirty" -eq 0 ]; then
  echo "✅ 未发现僵尸进程（tini 在干活）"
else
  echo "⚠️  合计 $total 个僵尸进程。kill 无效，只能重建容器："
  echo "    sh scripts/dev-zombie-check.sh --fix"
fi

if [ "${1:-}" = "--fix" ]; then
  echo
  echo "→ 重建 dev 容器（数据在命名卷里，不会丢）…"
  (cd "$ROOT" && docker compose -f "$COMPOSE_FILE" up -d --force-recreate --remove-orphans) || exit 2
  echo
  echo "→ 复查："
  if [ -x "$SELF" ]; then exec "$SELF"; else exec sh "$SELF"; fi
fi

[ "$dirty" -eq 0 ] || exit 1
exit 0
