-- CreateTable
CREATE TABLE "LaborReceivingSummary" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "laborAuthId" TEXT,
    "subcontractorName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "materialName" TEXT NOT NULL,
    "spec" TEXT,
    "unit" TEXT,
    "unitPrice" DECIMAL(18,4),
    "priceOverridden" BOOLEAN NOT NULL DEFAULT false,
    "designQtyCum" DECIMAL(18,3),
    "lossRate" DECIMAL(9,4),
    "returnQty" DECIMAL(18,3),
    "stockTakeQty" DECIMAL(18,3),
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaborReceivingSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LaborReceivingSummary_projectId_period_idx" ON "LaborReceivingSummary"("projectId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "LaborReceivingSummary_projectId_subcontractorName_period_ma_key" ON "LaborReceivingSummary"("projectId", "subcontractorName", "period", "materialName", "spec");

-- AddForeignKey
ALTER TABLE "LaborReceivingSummary" ADD CONSTRAINT "LaborReceivingSummary_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaborReceivingSummary" ADD CONSTRAINT "LaborReceivingSummary_laborAuthId_fkey" FOREIGN KEY ("laborAuthId") REFERENCES "LaborAuthLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

