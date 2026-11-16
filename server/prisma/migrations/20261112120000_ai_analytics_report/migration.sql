-- AI 经营数据助手：生成记录（报告正文 + 事实快照 + 表格文件 key）
-- 业务口径 2026-11-12：记录是快照；历史按创建人可见（跨项目可见），超管可看全部；
-- 不设 kind 列（hasReport / hasWorkbook 表达）；projectId 只作元数据与文件目录。
CREATE TABLE "AiAnalyticsReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdByName" TEXT,
    "title" TEXT NOT NULL,
    "rawText" TEXT,
    "intentJson" JSONB,
    "scopeJson" JSONB,
    "datasetKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "factsJson" JSONB,
    "warningsJson" JSONB,
    "unknownNumbersJson" JSONB,
    "discardedNumbersJson" JSONB,
    "scopeMode" TEXT,
    "projectCount" INTEGER NOT NULL DEFAULT 0,
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3),
    "periodLabel" TEXT,
    "compareMode" TEXT,
    "narrative" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "markdown" TEXT,
    "hasReport" BOOLEAN NOT NULL DEFAULT false,
    "workbookKey" TEXT,
    "workbookName" TEXT,
    "workbookSize" INTEGER,
    "hasWorkbook" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAnalyticsReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiAnalyticsReport_projectId_createdAt_idx" ON "AiAnalyticsReport"("projectId", "createdAt");
CREATE INDEX "AiAnalyticsReport_projectId_createdBy_createdAt_idx" ON "AiAnalyticsReport"("projectId", "createdBy", "createdAt");
CREATE INDEX "AiAnalyticsReport_createdBy_createdAt_idx" ON "AiAnalyticsReport"("createdBy", "createdAt");

ALTER TABLE "AiAnalyticsReport" ADD CONSTRAINT "AiAnalyticsReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
