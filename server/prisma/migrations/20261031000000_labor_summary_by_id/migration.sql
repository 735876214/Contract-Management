-- 分包单位领用月度汇总改按 ID 关联（2026-10-17「供应商/分包商信息统一」批次）：
-- 唯一键由名称（subcontractorName）改为 laborAuthId；laborAuthId 必填；
-- 分包商改名不再导致聚合断档，同名分包商不再撞唯一键。

-- 1. 数据清洗：laborAuthId 为空的行按 (projectId, subcontractorName) 回填台账 ID。
--    同项目同名必须唯一命中才回填；多命中（同名档案）或无命中（台账已删）→ 拦截，人工处理后重放。
DO $$
DECLARE
  bad_multi int;
  bad_missing int;
BEGIN
  SELECT count(*) INTO bad_multi FROM (
    SELECT s."projectId", s."subcontractorName"
    FROM "LaborReceivingSummary" s LEFT JOIN "LaborAuthLedger" l
      ON l."projectId" = s."projectId" AND l."subcontractorName" = s."subcontractorName"
    WHERE s."laborAuthId" IS NULL
    GROUP BY s."projectId", s."subcontractorName"
    HAVING count(DISTINCT l.id) > 1
  ) t;
  IF bad_multi > 0 THEN
    RAISE EXCEPTION '存在同项目同名的多条分包授权台账，无法唯一回填 laborAuthId（% 组），请人工合并后重放迁移', bad_multi;
  END IF;

  SELECT count(*) INTO bad_missing FROM "LaborReceivingSummary" s
  WHERE s."laborAuthId" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "LaborAuthLedger" l
      WHERE l."projectId" = s."projectId" AND l."subcontractorName" = s."subcontractorName"
    );
  IF bad_missing > 0 THEN
    RAISE EXCEPTION '存在 % 行汇总找不到同名分包授权台账（laborAuthId 为空且无同名档案），请人工确认归属后重放迁移', bad_missing;
  END IF;

  UPDATE "LaborReceivingSummary" s
  SET "laborAuthId" = l.id
  FROM "LaborAuthLedger" l
  WHERE s."laborAuthId" IS NULL
    AND l."projectId" = s."projectId"
    AND l."subcontractorName" = s."subcontractorName";
END $$;

-- 2. laborAuthId 必填
ALTER TABLE "LaborReceivingSummary" ALTER COLUMN "laborAuthId" SET NOT NULL;

-- 3. 唯一键：名称 → 台账 ID
DROP INDEX IF EXISTS "LaborReceivingSummary_projectId_subcontractorName_period_ma_key";
CREATE UNIQUE INDEX "LaborReceivingSummary_projectId_laborAuthId_period_material_key"
  ON "LaborReceivingSummary"("projectId", "laborAuthId", period, "materialName", spec);

-- 4. 外键：SetNull → Cascade（删台账行连带删汇总行，行按台账 ID 定位）
ALTER TABLE "LaborReceivingSummary" DROP CONSTRAINT "LaborReceivingSummary_laborAuthId_fkey";
ALTER TABLE "LaborReceivingSummary"
  ADD CONSTRAINT "LaborReceivingSummary_laborAuthId_fkey"
  FOREIGN KEY ("laborAuthId") REFERENCES "LaborAuthLedger"(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- 5. 文案统一（劳务 → 分包）：字典项「劳务退库」→「分包退库」；权限 module「劳务管理」→「分包管理」
UPDATE "DictItem" SET "itemName" = '分包退库' WHERE "typeCode" = 'material_source' AND "itemCode" = 'LABOR_RETURN' AND "itemName" = '劳务退库';
UPDATE "Permission" SET "module" = '分包管理' WHERE "module" = '劳务管理';
