-- AlterTable
ALTER TABLE "ContractTemplate" ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "fileUrl" TEXT;

-- AlterTable
ALTER TABLE "ProcurementTemplate" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "tags" TEXT,
ALTER COLUMN "version" SET DEFAULT 1;

-- CreateTable
CREATE TABLE "ProcurementTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "variables" TEXT,
    "tags" TEXT,
    "version" INTEGER NOT NULL,
    "operator" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcurementTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcurementTemplateVersion_templateId_idx" ON "ProcurementTemplateVersion"("templateId");

-- AddForeignKey
ALTER TABLE "ProcurementTemplateVersion" ADD CONSTRAINT "ProcurementTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProcurementTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

