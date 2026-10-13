-- ============================================================================
-- P1 一致性修复：清死字段 + 补关键外键 + 收领单↔日报显式关联 + 变量改名回填
--
-- 说明：本项目在 2026-09 将历史迁移折叠为基线 20260901000000_init，
-- 本迁移是基线之后的第一个增量迁移。
--
-- ⚠ 加外键前必须先做数据清洗：历史数据可能存在空字符串 '' 或指向已删除行的悬空值，
--   直接 ADD CONSTRAINT 会失败。清洗原则：**非破坏**——可空列置 NULL，不可空列则报错拦截。
-- ⚠ 语句顺序：新增列必须在引用它的清洗语句之前（整个迁移在一个事务内执行）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 结构变更：删列 / 新增列
-- ---------------------------------------------------------------------------

-- 删除死字段：指向已移除的 PaymentApply（既不写入也不读取）
ALTER TABLE "PaymentRecord" DROP COLUMN "applyId";

-- 采购任务 ↔ 合同改为「只由 Contract.taskId 一条表达」，移除双写字段
ALTER TABLE "ProcurementTask" DROP COLUMN "contractId";

-- 总日报新增来源收领单外键列（替代原先靠 receiptNo 文本匹配）
ALTER TABLE "DailyReport" ADD COLUMN "receiptOrderId" TEXT;

-- ---------------------------------------------------------------------------
-- 2) 数据清洗与回填（必须在 ADD CONSTRAINT 之前）
-- ---------------------------------------------------------------------------

-- 2.1 可空引用：空字符串 → NULL（Prisma 写入的空值可能是 ''，不是 NULL）
UPDATE "Contract"          SET "templateId"          = NULL WHERE "templateId"          = '';
UPDATE "Contract"          SET "technicalClauseId"   = NULL WHERE "technicalClauseId"   = '';
UPDATE "Contract"          SET "qualityClauseId"     = NULL WHERE "qualityClauseId"     = '';
UPDATE "Contract"          SET "paymentClauseId"     = NULL WHERE "paymentClauseId"     = '';
UPDATE "Contract"          SET "acceptanceClauseId"  = NULL WHERE "acceptanceClauseId"  = '';
UPDATE "ContractTemplate"  SET "parentId"             = NULL WHERE "parentId"             = '';
UPDATE "Subcontractor"     SET "subcontractId"        = NULL WHERE "subcontractId"        = '';
UPDATE "AssetLedger"       SET "receiptOrderId"       = NULL WHERE "receiptOrderId"       = '';
UPDATE "ReceiptOrder"      SET "subcontractorId"      = NULL WHERE "subcontractorId"      = '';
UPDATE "ReceiptOrderDetail" SET "materialId"          = NULL WHERE "materialId"           = '';

-- 2.2 可空引用：悬空（指向不存在的行）→ NULL，保留业务行本身
UPDATE "Contract" c SET "templateId" = NULL
  WHERE c."templateId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "ContractTemplate" t WHERE t.id = c."templateId");
UPDATE "Contract" c SET "technicalClauseId" = NULL
  WHERE c."technicalClauseId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Clause" x WHERE x.id = c."technicalClauseId");
UPDATE "Contract" c SET "qualityClauseId" = NULL
  WHERE c."qualityClauseId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Clause" x WHERE x.id = c."qualityClauseId");
UPDATE "Contract" c SET "paymentClauseId" = NULL
  WHERE c."paymentClauseId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Clause" x WHERE x.id = c."paymentClauseId");
UPDATE "Contract" c SET "acceptanceClauseId" = NULL
  WHERE c."acceptanceClauseId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Clause" x WHERE x.id = c."acceptanceClauseId");
UPDATE "ContractTemplate" t SET "parentId" = NULL
  WHERE t."parentId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "ContractTemplate" x WHERE x.id = t."parentId");
UPDATE "Subcontractor" s SET "subcontractId" = NULL
  WHERE s."subcontractId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Contract" x WHERE x.id = s."subcontractId");
UPDATE "AssetLedger" a SET "receiptOrderId" = NULL
  WHERE a."receiptOrderId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "ReceiptOrder" x WHERE x.id = a."receiptOrderId");
UPDATE "ReceiptOrder" r SET "subcontractorId" = NULL
  WHERE r."subcontractorId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Subcontractor" x WHERE x.id = r."subcontractorId");
UPDATE "ReceiptOrderDetail" d SET "materialId" = NULL
  WHERE d."materialId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "MaterialBase" x WHERE x.id = d."materialId");

-- 2.3 不可空引用 ProcurementTotalItem.materialBaseId → MaterialBase（ON DELETE RESTRICT）
--     该列不可空，无法置 NULL 兜底；且 service 层在写入时已校验物资必须存在于基础库
--     （procurement-task.service.ts 的 saveTotalList），故正常情况下不会出现悬空。
--     若确实存在悬空行，**报错拦截而非静默删除**，避免悄悄改变采购清单与预计采购金额。
DO $$
DECLARE bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
    FROM "ProcurementTotalItem" p
   WHERE p."materialBaseId" IS NULL
      OR p."materialBaseId" = ''
      OR NOT EXISTS (SELECT 1 FROM "MaterialBase" b WHERE b.id = p."materialBaseId");
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      '存在 % 条 ProcurementTotalItem 的 materialBaseId 无法关联到 MaterialBase；请先人工修复（或删除这些行）再执行本迁移',
      bad_count;
  END IF;
END $$;

-- 2.4 收领单 → 总日报：按 项目 + 收领单编号 回填显式外键（替代原先的 receiptNo 文本匹配）
UPDATE "DailyReport" d
   SET "receiptOrderId" = r.id
  FROM "ReceiptOrder" r
 WHERE d."receiptOrderId" IS NULL
   AND d."receiptNo" IS NOT NULL
   AND d."receiptNo" <> ''
   AND r."projectId" = d."projectId"
   AND r."orderNo" = d."receiptNo";

-- 2.5 变量改名回填：{{预计采购金额}} 拆分为带单位的两个变量名（docs/06 #1）
--     采前会取值口径为「万元」，成交报告为「元」；改名后旧占位符不再被替换，故同步回填模板正文。
UPDATE "ProcurementTemplate"
   SET content = replace(content, '{{预计采购金额}}', '{{预计采购金额(万元)}}')
 WHERE "moduleType" = 'PRE_MEETING'
   AND content LIKE '%{{预计采购金额}}%';
UPDATE "ProcurementTemplate"
   SET content = replace(content, '{{预计采购金额}}', '{{预计采购金额(元)}}')
 WHERE "moduleType" = 'RESULT_REPORT'
   AND content LIKE '%{{预计采购金额}}%';
-- 模板「已使用变量列表」JSON 中的键名同步改名
UPDATE "ProcurementTemplate"
   SET variables = replace(variables, '"预计采购金额"', '"预计采购金额(万元)"')
 WHERE "moduleType" = 'PRE_MEETING'
   AND variables LIKE '%"预计采购金额"%';
UPDATE "ProcurementTemplate"
   SET variables = replace(variables, '"预计采购金额"', '"预计采购金额(元)"')
 WHERE "moduleType" = 'RESULT_REPORT'
   AND variables LIKE '%"预计采购金额"%';

-- ---------------------------------------------------------------------------
-- 3) 索引与外键
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "Subcontractor_subcontractId_idx" ON "Subcontractor"("subcontractId");
CREATE INDEX "DailyReport_receiptOrderId_idx" ON "DailyReport"("receiptOrderId");
CREATE INDEX "ReceiptOrderDetail_materialId_idx" ON "ReceiptOrderDetail"("materialId");
CREATE INDEX "ProcurementTotalItem_materialBaseId_idx" ON "ProcurementTotalItem"("materialBaseId");

-- AddForeignKey
ALTER TABLE "Subcontractor" ADD CONSTRAINT "Subcontractor_subcontractId_fkey" FOREIGN KEY ("subcontractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ContractTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_technicalClauseId_fkey" FOREIGN KEY ("technicalClauseId") REFERENCES "Clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_qualityClauseId_fkey" FOREIGN KEY ("qualityClauseId") REFERENCES "Clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_paymentClauseId_fkey" FOREIGN KEY ("paymentClauseId") REFERENCES "Clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_acceptanceClauseId_fkey" FOREIGN KEY ("acceptanceClauseId") REFERENCES "Clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContractTemplate" ADD CONSTRAINT "ContractTemplate_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ContractTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_receiptOrderId_fkey" FOREIGN KEY ("receiptOrderId") REFERENCES "ReceiptOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AssetLedger" ADD CONSTRAINT "AssetLedger_receiptOrderId_fkey" FOREIGN KEY ("receiptOrderId") REFERENCES "ReceiptOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceiptOrder" ADD CONSTRAINT "ReceiptOrder_subcontractorId_fkey" FOREIGN KEY ("subcontractorId") REFERENCES "Subcontractor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReceiptOrderDetail" ADD CONSTRAINT "ReceiptOrderDetail_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "MaterialBase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProcurementTotalItem" ADD CONSTRAINT "ProcurementTotalItem_materialBaseId_fkey" FOREIGN KEY ("materialBaseId") REFERENCES "MaterialBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
