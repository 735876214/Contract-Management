-- 分包商库（Subcontractor）并入分包授权台账（LaborAuthLedger）——附件需求 2026-10-17 第三轮。
--
-- 业务口径：分包商库与分包授权台账合并；填报界面沿用原分包商库样式（委托书/四类图片/关联分包合同），
-- 导出用台账格式（分包材料员授权信息表.xlsx，图片内嵌）；菜单删除「分包商库」。
--
-- ⚠️ 本迁移有**数据搬迁**，顺序敏感（与 prisma migrate diff 的机械输出不同）：
--   ① 台账表补列 + 搬入旧档案数据（含四类图片字段，文件本体不动，只搬键/URL）
--   ② ReceiptOrder / SubcontractReceiving 的 subcontractorId 按「名称 + 项目」匹配改指台账行
--   ③ 删旧自引用列、切换外键、DROP 旧表
-- 匹配不到的引用置 NULL（保留业务行，名称快照仍在，不丢数据）。

-- ==================== ① 台账表补列 + 数据搬迁 ====================

ALTER TABLE "LaborAuthLedger" ADD COLUMN     "authorizedPersonIdNo" TEXT,
ADD COLUMN "idCardBack" TEXT,
ADD COLUMN "idCardFront" TEXT,
ADD COLUMN "projectName" TEXT,
ADD COLUMN "signatureScreenshot" TEXT,
ADD COLUMN "signedAuthFile" TEXT,
ADD COLUMN "subcontractContent" TEXT,
ADD COLUMN "subcontractId" TEXT;

-- 搬数据：旧档案一行 → 台账一行（subcontractorName 即关联键；期间两列台账独有，置 NULL 待用户补）
INSERT INTO "LaborAuthLedger" (
  "id", "projectId", "subcontractorName", "subcontractContent", "subcontractId",
  "legalPerson", "authorizedPerson", "authorizedPersonIdNo", "projectName",
  "idCardFront", "idCardBack", "signatureScreenshot", "signedAuthFile",
  "status", "remark", "createdBy", "createdAt", "version", "updatedAt"
)
SELECT
  s."id", s."projectId", s."subcontractorName", s."subcontractContent", s."subcontractId",
  s."legalPerson", s."authorizedPerson", s."authorizedPersonIdNo", s."projectName",
  s."idCardFront", s."idCardBack", s."signatureScreenshot", s."signedAuthFile",
  s."status", s."remark", s."createdBy", s."createdAt", 0, s."updatedAt"
FROM "Subcontractor" s;

-- ==================== ② 引用切换（先 drop 旧外键，再按名称匹配改指台账，最后建新外键） ====================

ALTER TABLE "ReceiptOrder" DROP CONSTRAINT "ReceiptOrder_subcontractorId_fkey";
ALTER TABLE "SubcontractReceiving" DROP CONSTRAINT "SubcontractReceiving_subcontractorId_fkey";
ALTER TABLE "Subcontractor" DROP CONSTRAINT "Subcontractor_subcontractId_fkey";

-- 按「分包商名称 + 项目」把旧档案 id 替换为台账 id；同项目同名称多条档案时取最新一条
UPDATE "ReceiptOrder" r
SET "subcontractorId" = l."id"
FROM "LaborAuthLedger" l
WHERE r."subcontractorId" IS NOT NULL
  AND l."projectId" = r."projectId"
  AND l."subcontractorName" = (SELECT s."subcontractorName" FROM "Subcontractor" s WHERE s."id" = r."subcontractorId")
  AND l."createdAt" = (SELECT MAX(l2."createdAt") FROM "LaborAuthLedger" l2
                       WHERE l2."projectId" = l."projectId" AND l2."subcontractorName" = l."subcontractorName");

UPDATE "SubcontractReceiving" sr
SET "subcontractorId" = l."id"
FROM "LaborAuthLedger" l
WHERE sr."subcontractorId" IS NOT NULL
  AND l."projectId" = sr."projectId"
  AND l."subcontractorName" = (SELECT s."subcontractorName" FROM "Subcontractor" s WHERE s."id" = sr."subcontractorId")
  AND l."createdAt" = (SELECT MAX(l2."createdAt") FROM "LaborAuthLedger" l2
                       WHERE l2."projectId" = l."projectId" AND l2."subcontractorName" = l."subcontractorName");

-- ==================== ③ 收尾：删旧自引用列与旧表 ====================

ALTER TABLE "LaborAuthLedger" DROP COLUMN "subcontractorId";

DROP TABLE "Subcontractor";

-- ==================== ④ 索引与外键（与目标 schema 一致） ====================

CREATE INDEX "LaborAuthLedger_subcontractorName_idx" ON "LaborAuthLedger"("subcontractorName");
CREATE INDEX "LaborAuthLedger_subcontractId_idx" ON "LaborAuthLedger"("subcontractId");

ALTER TABLE "LaborAuthLedger" ADD CONSTRAINT "LaborAuthLedger_subcontractId_fkey" FOREIGN KEY ("subcontractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SubcontractReceiving" ADD CONSTRAINT "SubcontractReceiving_subcontractorId_fkey" FOREIGN KEY ("subcontractorId") REFERENCES "LaborAuthLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReceiptOrder" ADD CONSTRAINT "ReceiptOrder_subcontractorId_fkey" FOREIGN KEY ("subcontractorId") REFERENCES "LaborAuthLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 收尾：删除旧权限码（分包商库菜单已删，功能并入 labor:*）
DELETE FROM "RolePermission" WHERE "permissionId" IN (SELECT "id" FROM "Permission" WHERE "code" IN ('subcontractor:view', 'subcontractor:edit'));
DELETE FROM "Permission" WHERE "code" IN ('subcontractor:view', 'subcontractor:edit');
