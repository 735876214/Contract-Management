-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "settlementId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "settlementStartDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReceiptOrder" ADD COLUMN     "settlementId" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_settlementId_idx" ON "Invoice"("settlementId");

-- CreateIndex
CREATE INDEX "ReceiptOrder_settlementId_idx" ON "ReceiptOrder"("settlementId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOrder" ADD CONSTRAINT "ReceiptOrder_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

