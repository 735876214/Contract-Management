-- DropForeignKey
ALTER TABLE "SubcontractReceiving" DROP CONSTRAINT "SubcontractReceiving_projectId_fkey";

-- DropForeignKey
ALTER TABLE "SubcontractReceiving" DROP CONSTRAINT "SubcontractReceiving_subcontractorId_fkey";

-- DropTable
DROP TABLE "SubcontractReceiving";

