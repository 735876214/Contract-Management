-- 迁移：新增「采购公告」表（批次二 · 任务 3.3）
-- 对应模型：ProcurementNotice（仅「单项采购」采购任务，状态为「采购公告编制中」时编辑）
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db push --schema prisma/schema.sqlite.prisma` 同步并验证
-- 备注：采购清单不落库，始终从「总采购清单」（ProcurementTotalItem）派生，保证只读且与总清单一致

CREATE TABLE "ProcurementNotice" (
  "id"               TEXT NOT NULL,
  "projectId"        TEXT NOT NULL,
  "taskId"           TEXT NOT NULL,
  "procurementNo"    TEXT,
  "procurementTime"  TIMESTAMP(3),
  "content"          TEXT,
  "techQuality"      TEXT,
  "acceptanceMethod" TEXT,
  "paymentMethod"    TEXT,
  "contacts"         TEXT,
  "contactPhones"    TEXT,
  "publishedAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version"          INTEGER NOT NULL DEFAULT 0,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProcurementNotice_pkey" PRIMARY KEY ("id")
);

-- 一个采购任务仅一份采购公告
CREATE UNIQUE INDEX "ProcurementNotice_taskId_key" ON "ProcurementNotice"("taskId");
CREATE INDEX "ProcurementNotice_projectId_idx" ON "ProcurementNotice"("projectId");

ALTER TABLE "ProcurementNotice"
  ADD CONSTRAINT "ProcurementNotice_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProcurementNotice"
  ADD CONSTRAINT "ProcurementNotice_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
