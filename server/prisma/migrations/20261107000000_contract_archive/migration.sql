-- 合同归档（业务口径 2026-10-18：单向归档，不提供解除归档）
-- 存量行 archivedAt = NULL 表示未归档，无需数据清洗。
ALTER TABLE "Contract" ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "archivedBy" TEXT;

CREATE INDEX "Contract_projectId_archivedAt_idx" ON "Contract"("projectId", "archivedAt");
