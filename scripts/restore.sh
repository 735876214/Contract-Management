#!/usr/bin/env bash
# CMS 恢复脚本（配套 scripts/backup.sh 的产物；演练与真实恢复同一入口）
#
# 用法：
#   scripts/restore.sh <日期 YYYY-MM-DD> [--drop] [--yes]
#     <日期>      要恢复到哪一天的备份（backups/{db,files}/<日期>/）
#     --drop      演练模式：先 DROP DATABASE 再重建（干净库重放）；默认用 pg_restore --clean 覆盖对象
#     --yes       跳过交互确认（自动化/CI 用）
#
# 恢复内容 = 数据库 + 附件目录（与备份范围对称）。
set -euo pipefail

CMS_DIR="${CMS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-${CMS_DIR}/backups}"
# 附件目录与 backup.sh 同口径：显式 DATA_DIR > docker-compose.yml 的 /data 挂载 > ${CMS_DIR}/data
derive_data_dir() {
  if [ -n "${DATA_DIR:-}" ]; then printf '%s' "${DATA_DIR}"; return; fi
  local compose="${CMS_DIR}/docker-compose.yml" host=""
  if [ -f "${compose}" ]; then
    host="$(sed -n -E 's/^[[:space:]]*-[[:space:]]*([^:#[:space:]]+):\/data[[:space:]]*(#.*)?$/\1/p' "${compose}" | head -1)"
  fi
  if [ -n "${host}" ]; then printf '%s' "${host}"; return; fi
  echo "WARN: 未配置 DATA_DIR，且未能从 ${compose} 解析 /data 挂载，回退 ${CMS_DIR}/data" >&2
  printf '%s' "${CMS_DIR}/data"
}
DATA_DIR="$(derive_data_dir)"
PG_CONTAINER="${PG_CONTAINER:-cms-postgres}"
PG_USER="${PG_USER:-cms}"
PG_DB="${CMS_DB:-cms}"

DATE="${1:?用法: restore.sh <YYYY-MM-DD> [--drop] [--yes]}"
DROP=0; YES=0
for a in "${@:2}"; do
  case "$a" in
    --drop) DROP=1 ;;
    --yes) YES=1 ;;
    *) echo "未知参数: $a"; exit 1 ;;
  esac
done

DB_FILE="${BACKUP_DIR}/db/${DATE}/cms.dump"
FILES_DIR="${BACKUP_DIR}/files/${DATE}"

[ -f "${DB_FILE}" ] || { echo "ERROR: 找不到 ${DB_FILE}"; exit 1; }
[ -d "${FILES_DIR}" ] || echo "WARN: 无 ${FILES_DIR}（当天的附件备份不存在，只恢复数据库）"

command -v docker >/dev/null || { echo "ERROR: 未找到 docker"; exit 1; }
command -v rsync >/dev/null || { echo "ERROR: 未找到 rsync"; exit 1; }

# 容器名兜底（同 backup.sh）
if ! docker ps --format '{{.Names}}' | grep -qx "${PG_CONTAINER}"; then
  ALT="$(docker ps --format '{{.Names}}' | grep -i postgres | head -1)"
  [ -n "${ALT}" ] && PG_CONTAINER="${ALT}" || { echo "ERROR: 找不到运行中的 postgres 容器"; exit 1; }
fi

echo "=============================================="
echo " 即将恢复到 ${DATE} 的备份："
echo "   数据库  : ${DB_FILE}（$(du -h "${DB_FILE}" | cut -f1)）"
[ -d "${FILES_DIR}" ] && echo "   附件目录: ${FILES_DIR} → ${DATA_DIR}"
[ "${DROP}" = "1" ] && echo "   模式    : --drop（先删库重建）"
echo " 当前数据库将被覆盖！"
echo "=============================================="
if [ "${YES}" != "1" ]; then
  read -r -p "确认恢复？输入 yes 继续：" CONFIRM
  [ "${CONFIRM}" = "yes" ] || { echo "已取消"; exit 1; }
fi

# ---------------- 1. 数据库 ----------------
if [ "${DROP}" = "1" ]; then
  echo "[1/3] DROP + 重建数据库 ${PG_DB} ..."
  # 断开现有连接（dev/演练库常有别的会话连着；生产恢复也应停应用后再跑）
  docker exec "${PG_CONTAINER}" psql -U "${PG_USER}" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PG_DB}' AND pid <> pg_backend_pid();" >/dev/null
  docker exec "${PG_CONTAINER}" psql -U "${PG_USER}" -d postgres \
    -c "DROP DATABASE IF EXISTS \"${PG_DB}\";" \
    -c "CREATE DATABASE \"${PG_DB}\" OWNER \"${PG_USER}\";"
  RESTORE_CMD=(docker exec -i "${PG_CONTAINER}" pg_restore -U "${PG_USER}" -d "${PG_DB}" --no-owner)
else
  echo "[1/3] pg_restore --clean 覆盖到现有库 ..."
  RESTORE_CMD=(docker exec -i "${PG_CONTAINER}" pg_restore -U "${PG_USER}" -d "${PG_DB}" --clean --if-exists --no-owner)
fi
if ! "${RESTORE_CMD[@]}" < "${DB_FILE}"; then
  echo "ERROR: pg_restore 失败"
  exit 1
fi

# ---------------- 2. 附件 ----------------
if [ -d "${FILES_DIR}" ]; then
  echo "[2/3] 恢复附件 → ${DATA_DIR} ..."
  mkdir -p "${DATA_DIR}"
  rsync -a "${FILES_DIR}/" "${DATA_DIR}/"
fi

# ---------------- 3. 冒烟验证 ----------------
echo "[3/3] 冒烟验证 ..."
SMOKE_SQL="SELECT 'users=' || count(*) FROM \"User\"; SELECT 'projects=' || count(*) FROM \"Project\";"
docker exec "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" -tAc "${SMOKE_SQL}"
echo "恢复完成（${DATE}）。"
