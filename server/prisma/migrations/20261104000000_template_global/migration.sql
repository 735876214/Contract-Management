-- DropIndex
DROP INDEX "ProcurementTemplate_projectId_moduleType_key";

-- AlterTable
ALTER TABLE "ProcurementTemplate" ALTER COLUMN "projectId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementTemplate_moduleType_key" ON "ProcurementTemplate"("moduleType");

