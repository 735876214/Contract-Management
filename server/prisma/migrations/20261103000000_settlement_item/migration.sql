-- CreateTable
CREATE TABLE "SettlementItem" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "materialBaseId" TEXT NOT NULL,
    "qty" DECIMAL(18,4),
    "priceBeforeTax" DECIMAL(18,4),
    "taxRatePct" DECIMAL(5,2),
    "priceWithTax" DECIMAL(18,4),
    "totalWithTax" DECIMAL(18,2),
    "remark" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementItem_settlementId_idx" ON "SettlementItem"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementItem_materialBaseId_idx" ON "SettlementItem"("materialBaseId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementItem_settlementId_materialBaseId_key" ON "SettlementItem"("settlementId", "materialBaseId");

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_materialBaseId_fkey" FOREIGN KEY ("materialBaseId") REFERENCES "MaterialBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

