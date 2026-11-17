-- 审计修复（2026-11-14）：上一个迁移 `labor_receiving_row_unit` 只在「单位能唯一推断」时回填，
-- 多单位历史行留空串；而运行时聚合桶用收领单真实单位 → 同一材料被拆成「空单位行 + 聚合行」，
-- 退库/盘点/设计量手填值悬空。这里做二次归一，并对无法推断的行显式报数。

-- 1) 空单位行：按「该单据 + 材料 + 规格」的收领单明细，取累计实收量最大的单位（并列取最近一单）。
--    旧行本身是跨单位合并的，无法还原到每个单位，只能确定性地挂到主单位。
UPDATE "LaborReceivingSummary" s
SET "unit" = COALESCE((
  SELECT TRIM(rd."unit")
  FROM "LaborReceivingDoc" d
  JOIN "ReceiptOrder" ro
    ON ro."projectId" = d."projectId" AND ro."receivingUnitId" = d."laborAuthId"
  JOIN "ReceiptOrderDetail" rd ON rd."orderId" = ro."id"
  WHERE d."id" = s."docId"
    AND ro."receivingUnitType" = 'SUBCONTRACTOR'
    AND TRIM(rd."materialName") = TRIM(s."materialName")
    AND COALESCE(rd."specModel", '') = COALESCE(TRIM(s."spec"), '')
    AND rd."unit" IS NOT NULL
    AND TRIM(rd."unit") <> ''
  GROUP BY TRIM(rd."unit")
  ORDER BY SUM(COALESCE(rd."receivedQty", 0)) DESC, MAX(ro."orderDate") DESC
  LIMIT 1
), s."unit")
WHERE s."unit" = '';

-- 2) 存量名称/规格/单位统一 trim（写入侧已 trim，历史未 trim 会与聚合键错位）。
--    先检查 trim 后是否产生重复；有重复直接拦截，要求人工合并（不静默删行）。
DO $$
DECLARE dup_groups integer;
BEGIN
  SELECT COUNT(*) INTO dup_groups FROM (
    SELECT "docId", TRIM("materialName"), COALESCE(TRIM("spec"), ''), TRIM("unit")
    FROM "LaborReceivingSummary"
    GROUP BY "docId", TRIM("materialName"), COALESCE(TRIM("spec"), ''), TRIM("unit")
    HAVING COUNT(*) > 1
  ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION '存在 % 组 trim 后重复的领用明细（docId+材料+规格+单位），请先人工合并后再应用本迁移', dup_groups;
  END IF;
END $$;

UPDATE "LaborReceivingSummary"
SET "materialName" = TRIM("materialName"),
    "spec" = COALESCE(TRIM("spec"), ''),
    "unit" = TRIM("unit")
WHERE "materialName" <> TRIM("materialName")
   OR "spec" IS NULL
   OR "spec" <> TRIM("spec")
   OR "unit" <> TRIM("unit");

-- 3) 仍无法推断单位的行（没有对应收领单明细）——留空串，但把数量报出来，便于人工核对。
DO $$
DECLARE leftover integer;
BEGIN
  SELECT COUNT(*) INTO leftover FROM "LaborReceivingSummary" WHERE "unit" = '';
  IF leftover > 0 THEN
    RAISE NOTICE '有 % 行领用明细无法从收领单推断计量单位，已保留空串；请在领用单据中手工确认单位', leftover;
  END IF;
END $$;
