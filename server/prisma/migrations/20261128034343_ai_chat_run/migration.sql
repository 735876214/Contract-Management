-- CreateTable
CREATE TABLE "AiChatRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdByName" TEXT,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answerText" TEXT,
    "accepted" BOOLEAN,
    "warningsJson" JSONB,
    "toolTraceJson" JSONB,
    "discardedJson" JSONB,
    "reportId" TEXT,
    "error" TEXT,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiChatRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiChatRun_createdBy_createdAt_idx" ON "AiChatRun"("createdBy", "createdAt");

-- CreateIndex
CREATE INDEX "AiChatRun_status_updatedAt_idx" ON "AiChatRun"("status", "updatedAt");
