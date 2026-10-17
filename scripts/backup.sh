#!/usr/bin/env bash
# CMS 每日备份（业务 2026-10-17：每天一次；首次全量，后续硬链接增量；保留 7 天）
#
# 备份范围 = PostgreSQL 数据库（pg_dump 自定义格式）+ 上传附件目录（docker-compose.yml 里 cms 服务挂的 NAS 路径，容器 /data）。
#
# 用法（宿主机 cron / NAS 计划任务）：
#   30 2 * * * /path/to/CMS/scripts/backup.sh >> /path/to/CMS/backups/backup.log 2>&1
#
# 结构：
#   backups/
#   ├── db/<YYYY-MM-DD>/cms.dump        # pg_dump -Fc（自定义格式，恢复用 pg_restore）
#   ├── files/<YYYY-MM-DD>/...          # 附件快照（rsync --link-dest 硬链接增量）
#   └── backup.log                      # 运行日志
#
# 「首次全量、后续硬链接增量」由 rsync --link-dest 自然实现：
# 没有前一日目录 → rsync 全量拷贝；有 → 未变文件硬链接到前一天（零额外空间），只写变更文件。
# 恢复见 scripts/restore.sh（恢复 = 直接拷贝某天目录 + pg_restore）。
set -euo pipefail

# ---------------- 配置（环境变量可覆盖） ----------------
CMS_DIR="${CMS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-${CMS_DIR}/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-7}"
PG_CONTAINER="${PG_CONTAINER:-cms-postgres}"
PG_USER="${PG_USER:-cms}"
PG_DB="${PG_DB:-cms}"
# 附件目录：与 docker-compose.yml 里 cms 服务挂载的 NAS 路径同口径（NAS 上改为实际路径）
DATA_DIR="${DATA_DIR:-${CMS_DIR}/data}"

DATE="$(date +%F)"
TODAY_DB="${BACKUP_DIR}/db/${DATE}"
TODAY_FILES="${BACKUP_DIR}/files/${DATE}"

log() { echo "[$(date '+%F %T')] $*"; }

# ---------------- 前置检查 ----------------
command -v docker >/dev/null || { log "ERROR: 未找到 docker"; exit 1; }
command -v rsync >/dev/null || { log "ERROR: 未找到 rsync（NAS 一般自带；alpine 容器需 apk add rsync）"; exit 1; }

# 容器名兜底：compose 项目名带前缀时按名字过滤运行中的 postgres 容器
if ! docker ps --format '{{.Names}}' | grep -qx "${PG_CONTAINER}"; then
  ALT="$(docker ps --format '{{.Names}}' | grep -i postgres | head -1)"
  if [ -n "${ALT}" ]; then
    log "WARN: 容器 ${PG_CONTAINER} 不在运行，改用 ${ALT}"
    PG_CONTAINER="${ALT}"
  else
    log "ERROR: 找不到运行中的 postgres 容器（${PG_CONTAINER}），备份中止"
    exit 1
  fi
fi

mkdir -p "${TODAY_DB}" "${TODAY_FILES}"

# ---------------- 1. 数据库（pg_dump -Fc） ----------------
DB_FILE="${TODAY_DB}/cms.dump"
if ! docker exec "${PG_CONTAINER}" pg_dump -U "${PG_USER}" -Fc "${PG_DB}" > "${DB_FILE}"; then
  log "ERROR: pg_dump 失败（容器 ${PG_CONTAINER}）"
  rm -f "${DB_FILE}"
  exit 1
fi
if [ ! -s "${DB_FILE}" ]; then
  log "ERROR: pg_dump 产物为空，视为失败"
  rm -f "${DB_FILE}"
  exit 1
fi
DB_SIZE="$(du -h "${DB_FILE}" | cut -f1)"

# ---------------- 2. 附件（rsync 硬链接增量） ----------------
mkdir -p "${DATA_DIR}"
# 前一日目录（找最近的、早于今天的；没有 → 首次全量）
PREV_DATE="$(ls -1 "${BACKUP_DIR}/files" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | grep -v "^${DATE}$" | sort | tail -1)"
if [ -n "${PREV_DATE}" ]; then
  MODE="增量"
  LINK_DEST="--link-dest=${BACKUP_DIR}/files/${PREV_DATE}"
else
  MODE="全量"
  LINK_DEST=""
fi
rsync -a --delete ${LINK_DEST} "${DATA_DIR}/" "${TODAY_FILES}/"

# 硬链接自检（增量模式下抽验：未变文件应为硬链接，链接数 ≥ 2）
LINKED=0
if [ "${MODE}" = "增量" ]; then
  LINKED="$(find "${TODAY_FILES}" -type f -links +1 2>/dev/null | wc -l)"
fi

# ---------------- 3. 滚动清理（保留最近 RETAIN_DAYS 天；防呆：目录数 < 2 不清） ----------------
PRUNED=0
for sub in db files; do
  COUNT="$(ls -1 "${BACKUP_DIR}/${sub}" 2>/dev/null | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || true)"
  if [ "${COUNT}" -ge 2 ]; then
    OLD="$(find "${BACKUP_DIR}/${sub}" -maxdepth 1 -mindepth 1 -type d -name '20*' -mtime +"${RETAIN_DAYS}" 2>/dev/null || true)"
    if [ -n "${OLD}" ]; then
      N="$(echo "${OLD}" | wc -l)"
      echo "${OLD}" | xargs rm -rf
      PRUNED=$((PRUNED + N))
    fi
  fi
done

# ---------------- 4. 日志 ----------------
log "备份完成：${MODE} · db ${DB_SIZE} · files 新建 $(find "${TODAY_FILES}" -type f | wc -l) 个（硬链接复用 ${LINKED} 个）· 清理 ${PRUNED} 个过期目录"
