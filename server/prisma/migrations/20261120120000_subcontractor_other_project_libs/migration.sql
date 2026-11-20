-- 分包商库 / 其他项目库（2026-11-20）
--
-- 1) 新增 Subcontractor（分包商主数据）与 OtherProject（其他项目库）两张表；
-- 2) LaborAuthLedger 挂靠 subcontractorId（名称仍为快照）；
-- 3) ReceiptOrder 增加泛型 supplyUnitId，subcontractorId 改指 Subcontractor，
--    非供应商类型的 supplierId 置空（历史上被当作通用供应单位 ID 复用，会撞 Supplier 外键）；
-- 4) 成本侧（LaborReceivingDoc / LaborReceivingSummary / MonthlyProfitLossDetail）
--    聚合键由 laborAuthId（台账行）改为 subcontractorId（分包商主数据）；
-- 5) 字典 other_project → OtherProject 并停用字典项。

-- ==================== 1. 新表 ====================

CREATE TABLE "Subcontractor" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "creditCode" TEXT,
    "legalPerson" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "remark" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subcontractor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OtherProject" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "remark" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OtherProject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subcontractor_projectId_name_key" ON "Subcontractor"("projectId", "name");
CREATE INDEX "Subcontractor_status_name_idx" ON "Subcontractor"("status", "name");
CREATE INDEX "Subcontractor_projectId_idx" ON "Subcontractor"("projectId");

CREATE UNIQUE INDEX "OtherProject_projectId_name_key" ON "OtherProject"("projectId", "name");
CREATE INDEX "OtherProject_status_name_idx" ON "OtherProject"("status", "name");
CREATE INDEX "OtherProject_projectId_idx" ON "OtherProject"("projectId");

-- ==================== 2. 分包商主数据回填（按 项目 + 名称 去重） ====================

INSERT INTO "Subcontractor" ("id", "projectId", "name", "legalPerson", "status", "version", "createdAt", "updatedAt")
SELECT
    'sub_' || replace(gen_random_uuid()::text, '-', ''),
    t."projectId",
    t."subcontractorName",
    t."legalPerson",
    1,
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON ("projectId", "subcontractorName")
        "projectId",
        "subcontractorName",
        "legalPerson"
    FROM "LaborAuthLedger"
    WHERE "subcontractorName" IS NOT NULL AND btrim("subcontractorName") <> ''
    ORDER BY "projectId", "subcontractorName", "createdAt" ASC
) t;

-- ==================== 3. 台账挂靠分包商主数据 ====================

ALTER TABLE "LaborAuthLedger" ADD COLUMN "subcontractorId" TEXT;

UPDATE "LaborAuthLedger" l
SET "subcontractorId" = s."id"
FROM "Subcontractor" s
WHERE s."projectId" = l."projectId"
  AND s."name" = l."subcontractorName";

CREATE INDEX "LaborAuthLedger_subcontractorId_idx" ON "LaborAuthLedger"("subcontractorId");

ALTER TABLE "LaborAuthLedger"
    ADD CONSTRAINT "LaborAuthLedger_subcontractorId_fkey"
    FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ==================== 4. 其他项目库回填（字典 other_project） ====================

INSERT INTO "OtherProject" ("id", "projectId", "code", "name", "status", "version", "createdAt", "updatedAt")
SELECT
    'op_' || replace(gen_random_uuid()::text, '-', ''),
    NULL,
    d."itemCode",
    d."itemName",
    CASE WHEN d."status" = 1 THEN 1 ELSE 0 END,
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON ("itemCode") "itemCode", "itemName", "status"
    FROM "DictItem"
    WHERE "typeCode" = 'other_project'
    ORDER BY "itemCode", "sortOrder" ASC
) d
ON CONFLICT ("projectId", "name") DO NOTHING;

-- 字典项停用（保留数据，不再作为收领单数据源）
UPDATE "DictItem" SET "status" = 0 WHERE "typeCode" = 'other_project';

-- ==================== 5. 收领单泛型供应单位 ID ====================

ALTER TABLE "ReceiptOrder" ADD COLUMN "supplyUnitId" TEXT;

-- 5.0 先摘掉指向 LaborAuthLedger 的旧外键：下面会把 subcontractorId 改写成「分包商主数据 ID」，
--     若旧外键仍在，UPDATE 时 sub_ 值不在 LaborAuthLedger 中会触发外键冲突。
ALTER TABLE "ReceiptOrder" DROP CONSTRAINT IF EXISTS "ReceiptOrder_subcontractorId_fkey";

-- 5.1 供应商：supplierId 即供应单位 ID
UPDATE "ReceiptOrder" SET "supplyUnitId" = "supplierId" WHERE "supplierType" = 'SUPPLIER' AND "supplierId" IS NOT NULL;

-- 5.2 分包商：旧 subcontractorId / receivingUnitId 存的是台账 ID → 映射到分包商主数据
UPDATE "ReceiptOrder" r
SET "supplyUnitId" = l."subcontractorId"
FROM "LaborAuthLedger" l
WHERE r."supplierType" = 'SUBCONTRACTOR'
  AND r."supplyUnitId" IS NULL
  AND r."subcontractorId" = l."id"
  AND l."subcontractorId" IS NOT NULL;

UPDATE "ReceiptOrder" r
SET "subcontractorId" = l."subcontractorId"
FROM "LaborAuthLedger" l
WHERE r."subcontractorId" = l."id"
  AND l."subcontractorId" IS NOT NULL;

UPDATE "ReceiptOrder" r
SET "receivingUnitId" = l."subcontractorId"
FROM "LaborAuthLedger" l
WHERE r."receivingUnitType" = 'SUBCONTRACTOR'
  AND r."receivingUnitId" = l."id"
  AND l."subcontractorId" IS NOT NULL;

-- 5.3 其他项目：旧值存的是字典 itemCode → 映射到 OtherProject.id
UPDATE "ReceiptOrder" r
SET "supplyUnitId" = o."id"
FROM "OtherProject" o
WHERE r."supplierType" = 'OTHER_PROJECT'
  AND r."supplyUnitId" IS NULL
  AND o."code" = r."supplierId";

UPDATE "ReceiptOrder" r
SET "receivingUnitId" = o."id"
FROM "OtherProject" o
WHERE r."receivingUnitType" = 'OTHER_PROJECT'
  AND o."code" = r."receivingUnitId";

-- 5.4 非供应商类型：supplierId 置空（避免撞 Supplier 外键；名称快照仍在 supplierName）
UPDATE "ReceiptOrder"
SET "supplierId" = NULL
WHERE "supplierType" IS NOT NULL
  AND "supplierType" <> 'SUPPLIER'
  AND "supplierId" IS NOT NULL;

-- 5.5 收领单 subcontractorId 外键改指 Subcontractor
ALTER TABLE "ReceiptOrder"
    ADD CONSTRAINT "ReceiptOrder_subcontractorId_fkey"
    FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ReceiptOrder_supplyUnitId_idx" ON "ReceiptOrder"("supplyUnitId");
CREATE INDEX "ReceiptOrder_receivingUnitType_receivingUnitId_idx"
    ON "ReceiptOrder"("receivingUnitType", "receivingUnitId");

-- ==================== 6. 成本侧聚合键 laborAuthId → subcontractorId ====================

-- 6.1 单据头：先摘旧外键/唯一键（否则映射为分包商 ID 时会撞旧外键、且多台账行合并后撞旧唯一键），再改名并映射
ALTER TABLE "LaborReceivingDoc" DROP CONSTRAINT IF EXISTS "LaborReceivingDoc_laborAuthId_fkey";
ALTER TABLE "LaborReceivingDoc" DROP CONSTRAINT IF EXISTS "LaborReceivingDoc_projectId_laborAuthId_period_key";
ALTER TABLE "LaborReceivingDoc" RENAME COLUMN "laborAuthId" TO "subcontractorId";

UPDATE "LaborReceivingDoc" d
SET "subcontractorId" = l."subcontractorId"
FROM "LaborAuthLedger" l
WHERE d."subcontractorId" = l."id"
  AND l."subcontractorId" IS NOT NULL;

-- 合并「同一分包商 + 同一结算期」的重复单据（台账行合并后才可能重复）：
-- 保留 id 最小的一张，冲突明细先删（docId + 材料 + 规格 + 单位唯一），其余明细迁入后删单。
WITH dup AS (
    SELECT d."id",
           d."projectId",
           d."subcontractorId",
           d."period",
           first_value(d."id") OVER (
               PARTITION BY d."projectId", d."subcontractorId", d."period"
               ORDER BY d."createdAt" ASC, d."id" ASC
           ) AS keep_id
    FROM "LaborReceivingDoc" d
)
DELETE FROM "LaborReceivingSummary" s
USING dup
WHERE s."docId" = dup."id"
  AND dup."id" <> dup.keep_id
  AND EXISTS (
      SELECT 1 FROM "LaborReceivingSummary" k
      WHERE k."docId" = dup.keep_id
        AND k."materialName" = s."materialName"
        AND k."spec" = s."spec"
        AND k."unit" = s."unit"
  );

WITH dup AS (
    SELECT d."id",
           first_value(d."id") OVER (
               PARTITION BY d."projectId", d."subcontractorId", d."period"
               ORDER BY d."createdAt" ASC, d."id" ASC
           ) AS keep_id
    FROM "LaborReceivingDoc" d
)
UPDATE "LaborReceivingSummary" s
SET "docId" = dup.keep_id
FROM dup
WHERE s."docId" = dup."id" AND dup."id" <> dup.keep_id;

WITH dup AS (
    SELECT d."id",
           first_value(d."id") OVER (
               PARTITION BY d."projectId", d."subcontractorId", d."period"
               ORDER BY d."createdAt" ASC, d."id" ASC
           ) AS keep_id
    FROM "LaborReceivingDoc" d
)
DELETE FROM "LaborReceivingDoc" d
USING dup
WHERE d."id" = dup."id" AND dup."id" <> dup.keep_id;

ALTER TABLE "LaborReceivingDoc"
    ADD CONSTRAINT "LaborReceivingDoc_subcontractorId_fkey"
    FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "LaborReceivingDoc_projectId_subcontractorId_period_key"
    ON "LaborReceivingDoc"("projectId", "subcontractorId", "period");

-- 6.2 明细行（冗余列）
ALTER TABLE "LaborReceivingSummary" RENAME COLUMN "laborAuthId" TO "subcontractorId";
UPDATE "LaborReceivingSummary" s
SET "subcontractorId" = d."subcontractorId"
FROM "LaborReceivingDoc" d
WHERE s."docId" = d."id";

-- 6.3 月度盈亏明细（快照来源）：先摘旧外键再改名/映射
ALTER TABLE "MonthlyProfitLossDetail" DROP CONSTRAINT IF EXISTS "MonthlyProfitLossDetail_laborAuthId_fkey";
ALTER TABLE "MonthlyProfitLossDetail" RENAME COLUMN "laborAuthId" TO "subcontractorId";
UPDATE "MonthlyProfitLossDetail" d
SET "subcontractorId" = l."subcontractorId"
FROM "LaborAuthLedger" l
WHERE d."subcontractorId" = l."id"
  AND l."subcontractorId" IS NOT NULL;

ALTER TABLE "MonthlyProfitLossDetail"
    ADD CONSTRAINT "MonthlyProfitLossDetail_subcontractorId_fkey"
    FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ==================== 7. 权限（新库菜单） ====================

INSERT INTO "Permission" ("id", "code", "name", "module") VALUES
    ('perm_subcontractor_view_' || substr(md5(random()::text), 1, 8), 'subcontractor:view', '查看分包商库', '分包商库'),
    ('perm_subcontractor_edit_' || substr(md5(random()::text), 1, 8), 'subcontractor:edit', '维护分包商库', '分包商库'),
    ('perm_other_project_view_' || substr(md5(random()::text), 1, 8), 'other-project:view', '查看其他项目库', '其他项目库'),
    ('perm_other_project_edit_' || substr(md5(random()::text), 1, 8), 'other-project:edit', '维护其他项目库', '其他项目库')
ON CONFLICT ("code") DO NOTHING;

-- 管理员角色补齐新权限（若已有 isSuperAdmin 角色体系，这里仅补 role 名称 '管理员'）
INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT 'rp_' || substr(md5(r."id" || p."id"), 1, 20), r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = '管理员'
  AND p."code" IN ('subcontractor:view', 'subcontractor:edit', 'other-project:view', 'other-project:edit')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
