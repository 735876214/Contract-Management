-- AlterTable
ALTER TABLE "ReceiptOrder" ADD COLUMN     "scanFileName" TEXT,
ADD COLUMN     "scanUrl" TEXT;

-- CreateTable
CREATE TABLE "LaborAuthLedger" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subcontractorId" TEXT,
    "subcontractorName" TEXT NOT NULL,
    "legalPerson" TEXT,
    "authorizedPerson" TEXT,
    "authStartDate" TIMESTAMP(3),
    "authEndDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'EDITING',
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaborAuthLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractReceiving" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subcontractorId" TEXT,
    "subcontractorName" TEXT NOT NULL,
    "period" TEXT,
    "materialName" TEXT,
    "spec" TEXT,
    "unit" TEXT,
    "qty" DECIMAL(18,3),
    "unitPrice" DECIMAL(18,2),
    "amount" DECIMAL(18,2),
    "useLocation" TEXT,
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubcontractReceiving_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfitLossAnalysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "period" TEXT,
    "materialName" TEXT,
    "contractAmount" DECIMAL(18,2),
    "settleAmount" DECIMAL(18,2),
    "actualCost" DECIMAL(18,2),
    "profitLoss" DECIMAL(18,2),
    "profitRate" DECIMAL(9,4),
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfitLossAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LaborAuthLedger_projectId_idx" ON "LaborAuthLedger"("projectId");

-- CreateIndex
CREATE INDEX "SubcontractReceiving_projectId_idx" ON "SubcontractReceiving"("projectId");

-- CreateIndex
CREATE INDEX "ProfitLossAnalysis_projectId_idx" ON "ProfitLossAnalysis"("projectId");

-- AddForeignKey
ALTER TABLE "LaborAuthLedger" ADD CONSTRAINT "LaborAuthLedger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaborAuthLedger" ADD CONSTRAINT "LaborAuthLedger_subcontractorId_fkey" FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubcontractReceiving" ADD CONSTRAINT "SubcontractReceiving_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubcontractReceiving" ADD CONSTRAINT "SubcontractReceiving_subcontractorId_fkey" FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfitLossAnalysis" ADD CONSTRAINT "ProfitLossAnalysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

