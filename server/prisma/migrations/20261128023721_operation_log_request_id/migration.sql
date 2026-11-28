-- AlterTable
ALTER TABLE "OperationLog" ADD COLUMN     "requestId" TEXT;

-- CreateIndex
CREATE INDEX "OperationLog_requestId_idx" ON "OperationLog"("requestId");
