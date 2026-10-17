-- DropForeignKey
ALTER TABLE "ProfitLossAnalysis" DROP CONSTRAINT "ProfitLossAnalysis_projectId_fkey";

-- DropTable
DROP TABLE "ProfitLossAnalysis";

-- CreateTable
CREATE TABLE "MonthlyProfitLoss" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "sixSavingsAmount" DECIMAL(18,2),
    "totalDeductAmount" DECIMAL(18,2),
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyProfitLoss_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyProfitLossDetail" (
    "id" TEXT NOT NULL,
    "profitLossId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "laborAuthId" TEXT,
    "laborTeamName" TEXT NOT NULL,
    "owner" TEXT,
    "materialName" TEXT NOT NULL,
    "spec" TEXT,
    "unit" TEXT,
    "unitPrice" DECIMAL(18,4),
    "entryQty" DECIMAL(18,3),
    "designQty" DECIMAL(18,3),
    "lossRate" DECIMAL(9,4),
    "theoryUseQty" DECIMAL(18,3),
    "actualUseQty" DECIMAL(18,3),
    "stockQty" DECIMAL(18,3),
    "saveOverQty" DECIMAL(18,3),
    "saveOverAmount" DECIMAL(18,2),
    "saveRate" DECIMAL(9,4),
    "deductAmount" DECIMAL(18,2),
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyProfitLossDetail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonthlyProfitLoss_projectId_idx" ON "MonthlyProfitLoss"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyProfitLoss_projectId_period_key" ON "MonthlyProfitLoss"("projectId", "period");

-- CreateIndex
CREATE INDEX "MonthlyProfitLossDetail_profitLossId_idx" ON "MonthlyProfitLossDetail"("profitLossId");

-- AddForeignKey
ALTER TABLE "MonthlyProfitLoss" ADD CONSTRAINT "MonthlyProfitLoss_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyProfitLossDetail" ADD CONSTRAINT "MonthlyProfitLossDetail_profitLossId_fkey" FOREIGN KEY ("profitLossId") REFERENCES "MonthlyProfitLoss"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyProfitLossDetail" ADD CONSTRAINT "MonthlyProfitLossDetail_laborAuthId_fkey" FOREIGN KEY ("laborAuthId") REFERENCES "LaborAuthLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

