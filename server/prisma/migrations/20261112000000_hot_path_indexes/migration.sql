-- 第 15/16 轮审计：给三条热路径补索引（纯加索引，无数据变更、可安全回滚）。
--
-- 1) Notification：表上原本只有主键。通知列表 / 未读徽标是**每个用户每 30 秒**轮询的
--    接口（notification.service.ts 的 findAll + unreadCount），where 是
--    { userId, isRead?, projectId? } + orderBy [isRead asc, createdAt desc]，
--    行数上去后每次都是全表顺序扫描 + 排序。
-- 2) Contract：列表/台账/看板都按 projectId + createdAt desc 取，原来只有
--    (projectId, supplierId) 与 (projectId, archivedAt) 两个组合索引。
-- 3) Supplier：下拉按 status = 1 + name asc 过滤排序，且是全库共享表（不分项目），
--    原来只有 name 唯一索引。
--
-- 索引名与 Prisma 的默认命名一致（表名_列名_idx），这样 `prisma migrate diff`
-- 不会认为 schema 与库不一致。

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Contract_projectId_createdAt_idx" ON "Contract"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Supplier_status_name_idx" ON "Supplier"("status", "name");
