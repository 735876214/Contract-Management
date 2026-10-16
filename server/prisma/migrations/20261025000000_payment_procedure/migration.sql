-- CreateTable
CREATE TABLE "PaymentProcedure" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "supplierId" TEXT,
    "contractId" TEXT,
    "code" TEXT,
    "settleCumAmount" DECIMAL(18,2),
    "paidCumAmount" DECIMAL(18,2),
    "unpaidAmount" DECIMAL(18,2),
    "payDate" TIMESTAMP(3),
    "statusCode" TEXT,
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProcedure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentProcedure_projectId_payDate_idx" ON "PaymentProcedure"("projectId", "payDate");

-- CreateIndex
CREATE INDEX "PaymentProcedure_contractId_idx" ON "PaymentProcedure"("contractId");

-- CreateIndex
CREATE INDEX "PaymentProcedure_supplierId_idx" ON "PaymentProcedure"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProcedure_projectId_code_key" ON "PaymentProcedure"("projectId", "code");

-- AddForeignKey
ALTER TABLE "PaymentProcedure" ADD CONSTRAINT "PaymentProcedure_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProcedure" ADD CONSTRAINT "PaymentProcedure_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProcedure" ADD CONSTRAINT "PaymentProcedure_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

