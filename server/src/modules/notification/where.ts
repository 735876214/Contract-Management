/**
 * 通知列表的 where —— 纯函数（service 里全是 Prisma，跑不了单测）。
 *
 * 两条硬约束：
 * 1. **只能看自己的**：`userId` 永远由当前登录用户决定，不接受前端传；
 * 2. `isRead` 兼容历史取值 `'read'/'unread'`（曾因只认 true/1 导致「已读」筛选恒返回未读）。
 */
export function notificationListWhere(
  query: { isRead?: unknown; projectId?: unknown } | null | undefined,
  userId: string,
): Record<string, any> {
  const where: Record<string, any> = { userId };
  if (query?.isRead !== undefined && query.isRead !== null && String(query.isRead) !== '') {
    const raw = String(query.isRead).trim().toLowerCase();
    where.isRead = raw === 'true' || raw === '1' || raw === 'read';
  }
  const projectId = String(query?.projectId ?? '').trim();
  if (projectId) where.projectId = projectId;
  return where;
}
