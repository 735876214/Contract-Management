-- 迁移：新增「采前会会议纪要」表（批次二 · 任务 3.2）
-- 对应模型：PreMeetingMinutes（仅「单项采购」且预计采购金额 ≥ 100 万元的采购任务生成）
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db push --schema prisma/schema.sqlite.prisma` 同步并验证

CREATE TABLE "PreMeetingMinutes" (
  "id"            TEXT NOT NULL,
  "projectId"     TEXT NOT NULL,
  "taskId"        TEXT NOT NULL,
  "meetingTime"   TIMESTAMP(3),
  "content"       TEXT,
  "host"          TEXT,
  "attendees"     TEXT,
  "writer"        TEXT,
  "reviewer"      TEXT,
  "purchaseItems" TEXT,
  "techQuality"   TEXT,
  "acceptance"    TEXT,
  "paymentTerms"  TEXT,
  "costRows"      TEXT,
  "inquirySheets" TEXT,
  "publishedAt"   TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version"       INTEGER NOT NULL DEFAULT 0,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PreMeetingMinutes_pkey" PRIMARY KEY ("id")
);

-- 一个采购任务仅一份采前会会议纪要
CREATE UNIQUE INDEX "PreMeetingMinutes_taskId_key" ON "PreMeetingMinutes"("taskId");
CREATE INDEX "PreMeetingMinutes_projectId_idx" ON "PreMeetingMinutes"("projectId");

ALTER TABLE "PreMeetingMinutes"
  ADD CONSTRAINT "PreMeetingMinutes_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PreMeetingMinutes"
  ADD CONSTRAINT "PreMeetingMinutes_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
