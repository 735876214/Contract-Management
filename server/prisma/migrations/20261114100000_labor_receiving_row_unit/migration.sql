-- 行键加入计量单位：同名同规格但单位不同的材料（如「钢管 DN50」按米/根）
-- 是两条独立的领用，不能合并数量与均价。

-- 1) 历史 NULL 归一：
--    能从收领单明细唯一推断单位就回填（同一材料+规格的历史明细只有一个单位时），
--    否则留空串。新唯一键要求非空。
UPDATE "LaborReceivingSummary" s
SET "unit" = COALESCE((
  SELECT MIN(TRIM(rd."unit"))
  FROM "LaborReceivingDoc" d
  JOIN "ReceiptOrder" ro
    ON ro."projectId" = d."projectId" AND ro."receivingUnitId" = d."laborAuthId"
  JOIN "ReceiptOrderDetail" rd ON rd."orderId" = ro."id"
  WHERE d."id" = s."docId"
    AND TRIM(rd."materialName") = s."materialName"
    AND COALESCE(rd."specModel", '') = s."spec"
    AND rd."unit" IS NOT NULL
    AND TRIM(rd."unit") <> ''
  HAVING COUNT(DISTINCT TRIM(rd."unit")) = 1
), '')
WHERE s."unit" IS NULL;

ALTER TABLE "LaborReceivingSummary" ALTER COLUMN "unit" SET DEFAULT '';
ALTER TABLE "LaborReceivingSummary" ALTER COLUMN "unit" SET NOT NULL;

-- 2) 唯一键加入 unit（旧键保证 (docId, materialName, spec) 唯一，故不会产生新重复）
DROP INDEX IF EXISTS "LaborReceivingSummary_docId_materialName_spec_key";
CREATE UNIQUE INDEX "LaborReceivingSummary_docId_materialName_spec_unit_key"
  ON "LaborReceivingSummary"("docId", "materialName", "spec", "unit");
