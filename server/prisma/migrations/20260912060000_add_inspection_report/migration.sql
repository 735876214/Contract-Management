-- 迁移：新增「考察报告」表（批次二 · 任务 3.7）
-- 对应模型：InspectionReport（独立模块，记录对供应商（考察单位）的考察情况）
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db push --schema prisma/schema.sqlite.prisma` 同步并验证
-- 备注：考察报告不挂在采购任务阶段链上，状态仅「编辑中 → 已完成」（publishedAt 回填）；
--       考察照片（photos）以 JSON 数组保存 [{ fileName, url, size }]，由 /api/files/upload 上传。

CREATE TABLE "InspectionReport" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "unitName"        TEXT NOT NULL,
  "inspectionTime"  TIMESTAMP(3),
  "inspectionPlace" TEXT,
  "inspectors"      TEXT,
  "content"         TEXT,
  "conclusion"      TEXT,
  "photos"          TEXT,
  "publishedAt"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version"         INTEGER NOT NULL DEFAULT 0,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InspectionReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InspectionReport_projectId_idx" ON "InspectionReport"("projectId");

ALTER TABLE "InspectionReport"
  ADD CONSTRAINT "InspectionReport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
