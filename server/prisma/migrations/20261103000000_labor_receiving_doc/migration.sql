-- DropForeignKey
ALTER TABLE "LaborReceivingSummary" DROP CONSTRAINT "LaborReceivingSummary_laborAuthId_fkey";

-- DropIndex
DROP INDEX "LaborReceivingSummary_projectId_laborAuthId_period_material_key";

-- AlterTable
ALTER TABLE "LaborReceivingSummary" ADD COLUMN     "docId" TEXT NOT NULL,
ALTER COLUMN "spec" SET NOT NULL;

-- CreateTable
CREATE TABLE "LaborReceivingDoc" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "laborAuthId" TEXT NOT NULL,
    "subcontractorName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "contractName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaborReceivingDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LaborReceivingDoc_projectId_idx" ON "LaborReceivingDoc"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "LaborReceivingDoc_projectId_laborAuthId_period_key" ON "LaborReceivingDoc"("projectId", "laborAuthId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "LaborReceivingSummary_docId_materialName_spec_key" ON "LaborReceivingSummary"("docId", "materialName", "spec");

-- AddForeignKey
ALTER TABLE "LaborReceivingDoc" ADD CONSTRAINT "LaborReceivingDoc_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 回填：已有汇总行按 (projectId, laborAuthId, period) 自动建单据（数据迁移，业务确认）
INSERT INTO "LaborReceivingDoc" ("id", "projectId", "docNo", "laborAuthId", "subcontractorName", "period", "status", "createdAt", "updatedAt")
SELECT
  'lrd' || md5(random()::text || clock_timestamp()::text),
  s."projectId",
  'LRD-' || replace(s."period", '-', '') || '-' || ROW_NUMBER() OVER (PARTITION BY s."projectId" ORDER BY s."period"),
  s."laborAuthId",
  s."subcontractorName",
  s."period",
  'DRAFT',
  now(), now()
FROM (SELECT DISTINCT "projectId", "laborAuthId", "subcontractorName", "period"
      FROM "LaborReceivingSummary") s;

UPDATE "LaborReceivingSummary" u
SET "docId" = d."id"
FROM "LaborReceivingDoc" d
WHERE d."projectId" = u."projectId" AND d."laborAuthId" = u."laborAuthId" AND d."period" = u."period";

-- AddForeignKey
ALTER TABLE "LaborReceivingDoc" ADD CONSTRAINT "LaborReceivingDoc_laborAuthId_fkey" FOREIGN KEY ("laborAuthId") REFERENCES "LaborAuthLedger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaborReceivingSummary" ADD CONSTRAINT "LaborReceivingSummary_docId_fkey" FOREIGN KEY ("docId") REFERENCES "LaborReceivingDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

