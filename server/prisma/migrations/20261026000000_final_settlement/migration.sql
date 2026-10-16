-- CreateTable
CREATE TABLE "FinalSettlement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "code" TEXT,
    "statusCode" TEXT NOT NULL DEFAULT 'PENDING_ATTACHMENT',
    "settledAt" TIMESTAMP(3),
    "totalAmount" DECIMAL(18,2),
    "attachmentUrl" TEXT,
    "attachmentName" TEXT,
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinalSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinalSettlementItem" (
    "id" TEXT NOT NULL,
    "finalSettlementId" TEXT NOT NULL,
    "settleMonth" TEXT NOT NULL,
    "amount" DECIMAL(18,2),
    "settlementId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinalSettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinalSettlement_projectId_contractId_idx" ON "FinalSettlement"("projectId", "contractId");

-- CreateIndex
CREATE INDEX "FinalSettlement_statusCode_idx" ON "FinalSettlement"("statusCode");

-- CreateIndex
CREATE UNIQUE INDEX "FinalSettlement_projectId_code_key" ON "FinalSettlement"("projectId", "code");

-- CreateIndex
CREATE INDEX "FinalSettlementItem_finalSettlementId_idx" ON "FinalSettlementItem"("finalSettlementId");

-- CreateIndex
CREATE INDEX "FinalSettlementItem_settlementId_idx" ON "FinalSettlementItem"("settlementId");

-- AddForeignKey
ALTER TABLE "FinalSettlement" ADD CONSTRAINT "FinalSettlement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinalSettlement" ADD CONSTRAINT "FinalSettlement_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinalSettlementItem" ADD CONSTRAINT "FinalSettlementItem_finalSettlementId_fkey" FOREIGN KEY ("finalSettlementId") REFERENCES "FinalSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinalSettlementItem" ADD CONSTRAINT "FinalSettlementItem_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

