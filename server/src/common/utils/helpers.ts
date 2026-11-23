import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

/**
 * 分页参数处理。
 * maxPageSize 供导出等批量场景显式放宽单页上限（默认 500），
 * 避免 pageSize 被静默截断导致导出数据缺失。
 */
export function paginate(query: any = {}, maxPageSize = 500) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(query.pageSize) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function buildResult(list: any[], total: number, query: any = {}) {
  return {
    list,
    total,
    page: Math.max(1, Number(query.page) || 1),
    pageSize: Math.min(500, Math.max(1, Number(query.pageSize) || 20)),
  };
}

/** 单次导入最大行数（需求 3.4 性能要求） */
export const IMPORT_MAX_ROWS = 5000;

/**
 * 账期字段（付款月份 `payMonth` / 结算月份 `settleMonth`）格式校验：必须是 `YYYY-MM`。
 *
 * 为什么要拦：台账与看板对这些字段做**字符串精确匹配**
 * （`ledger.service.ts` 的 `payMonth = query.month`、`dashboard.service.ts` 的按月聚合），
 * 写成 `2026-9` / `2026/09` / `2026-9-1` 都能存进去，但那一行永远不会被任何月份的统计命中——
 * 界面上看到的是「保存成功」，账上的当月付款/结算额却静默少一块。
 */
export function assertYearMonth(value: any, label = '月份') {
  if (value === null || value === undefined || value === '') return;
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw new BadRequestException(`${label}须为 YYYY-MM 格式（如 2026-09），当前为「${s}」`);
  }
}

/** 导入行数上限校验，超出时抛错提示分批 */
export function assertImportRows(rows: any[], max = IMPORT_MAX_ROWS) {
  if (rows.length > max) {
    throw new BadRequestException(`单次导入最多 ${max} 行，当前 ${rows.length} 行，请分批导入（每批不超过 ${max} 行）`);
  }
}

/**
 * 乐观锁的**原子**写入（2026-11-23 第 24 轮审计）：
 * 更新条件里带上 `version`，同一条 SQL 里 `version + 1`。
 *
 * 背景：`assertVersion()` 是「读 → 比 → 按 id 无条件 update」，校验与写入之间没有互斥。
 * 另一个请求在这个窗口内提交后，本次写入依然会覆盖对方（lost update），
 * 并把 version 推到 +1 —— 系统认为一切正常，是最难排查的一类数据错误。
 *
 * 用法：先 `assertVersion(old, data)` 给出友好 409（可选，便于提前拦），再
 * `versionedUpdate(this.prisma.xxx, id, old.version, payload)`。
 * 命中不了行（P2025：版本不符 **或** 已被删除）统一转 409，让前端「刷新后重试」。
 * 注意：`where` 用的是 Prisma 5 的 extendedWhereUnique（唯一键 + 普通列同用），
 * 因此 `include` / 嵌套写（`details: { create }`）照常可用。
 */
export async function versionedUpdate<T = any>(
  delegate: { update: (args: any) => Promise<T> },
  id: string,
  version: unknown,
  data: Record<string, any>,
  opts: { conflictMessage?: string; include?: Record<string, any> } = {},
): Promise<T> {
  try {
    return await delegate.update({
      // version 在最后展开：调用方在 data 里塞的 version 一律被覆盖（否则锁又失效）
      where: { id, version: Number(version) },
      data: { ...data, version: { increment: 1 } },
      ...(opts.include ? { include: opts.include } : {}),
    });
  } catch (e: any) {
    if (e?.code === 'P2025') {
      throw new ConflictException(opts.conflictMessage || '数据已被其他用户修改或已删除，请刷新后重试');
    }
    throw e;
  }
}

/**
 * 单条记录的**项目归属**校验（按 id 读写删的统一入口）。
 *
 * 背景：`JwtAuthGuard` 只校验「当前用户是不是请求头里那个项目的成员」，
 * 不校验「这条记录是不是那个项目的」；而权限码是全局 RBAC。少这一道，用户同时属于
 * A、B 两个项目时拿 B 的 id 配 A 的项目头就能跨项目读/改/删（2026-10 审计在
 * 收领单、发票、还款、付款、劳务、资金费用、结算、成本 **8 个模块**各发现一次）。
 *
 * 语义：
 * - `row` 为空 → 404（语义与「不属于本项目」一致，不暴露记录是否存在）；
 * - `projectId` 未传（内部调用/集成测试）→ 只校验存在；
 * - `projectId` 不匹配 → 404（同样不暴露存在性）。
 */
export function assertInProject<T extends { projectId?: string | null }>(
  row: T | null | undefined,
  projectId: string | undefined,
  message = '记录不存在',
): T {
  if (!row) throw new NotFoundException(message);
  if (projectId && row.projectId !== projectId) throw new NotFoundException(message);
  return row;
}

/** 乐观锁校验：客户端提交的版本号与库中不一致时拒绝更新（需求 2.2） */
export function assertVersion(oldRow: any, data: any) {
  if (!oldRow || oldRow.version === undefined || oldRow.version === null) return;
  const v = data?.version;
  // 2026-10-18 审计：省略 version = 无条件最后写入者胜，乐观锁形同虚设。
  // 所有前端写入路径都会回传 version（表单种子来自 GET），故此处改为强制要求；
  // 确有「不需要并发保护」的内部调用，应显式传 data.version = oldRow.version。
  if (v === undefined || v === null || v === '') {
    throw new ConflictException('缺少 version 字段（乐观锁），请刷新后重试');
  }
  if (Number(v) !== Number(oldRow.version)) {
    throw new ConflictException('数据已被其他用户修改，请刷新后重试');
  }
}
