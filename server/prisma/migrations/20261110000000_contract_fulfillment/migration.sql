-- 合同履约节点（四域扩展按需项 2026-10-18）
CREATE TABLE "ContractFulfillment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "planDate" TIMESTAMP(3),
    "actualDate" TIMESTAMP(3),
    "owner" TEXT,
    "statusCode" TEXT,
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractFulfillment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContractFulfillment_projectId_contractId_idx" ON "ContractFulfillment"("projectId", "contractId");
CREATE INDEX "ContractFulfillment_planDate_idx" ON "ContractFulfillment"("planDate");

ALTER TABLE "ContractFulfillment" ADD CONSTRAINT "ContractFulfillment_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContractFulfillment" ADD CONSTRAINT "ContractFulfillment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
