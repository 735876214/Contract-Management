-- AlterTable
ALTER TABLE "SettlementLedger" ADD COLUMN     "settlementId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SettlementLedger_settlementId_key" ON "SettlementLedger"("settlementId");

-- AddForeignKey
ALTER TABLE "SettlementLedger" ADD CONSTRAINT "SettlementLedger_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

