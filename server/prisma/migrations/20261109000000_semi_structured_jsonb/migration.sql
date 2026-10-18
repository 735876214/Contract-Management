-- 半结构化字段改 PG jsonb（四域扩展按需项 2026-10-18）
-- 这些列历史上是 TEXT 存 JSON 数组字符串；空串先归一为 NULL，非 JSON 的脏数据
-- 在迁移内显式报错（不能静默删数据），再统一转为 jsonb。
-- 涉及：框架协议事前说明（询价/价格对比/成本/附表/引用供应商）、
-- 采前会（采购清单/成本分析/询价单图片/联系人/联系电话）、
-- 成交报告（响应单位明细/拟推荐候选人）、采购公告（联系人/联系电话）。

-- 1) 清洗：空串 → NULL；非 JSON 数组 → 报错
DO $$
DECLARE
  t record;
  bad int;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('FrameworkExplanation', 'inquiryRows'),
      ('FrameworkExplanation', 'priceCompareRows'),
      ('FrameworkExplanation', 'costRows'),
      ('FrameworkExplanation', 'attachments'),
      ('FrameworkExplanation', 'referenceSuppliers'),
      ('PreMeetingMinutes', 'purchaseItems'),
      ('PreMeetingMinutes', 'costRows'),
      ('PreMeetingMinutes', 'inquirySheets'),
      ('ProcurementNotice', 'contacts'),
      ('ProcurementNotice', 'contactPhones'),
      ('ProcurementResultReport', 'suppliers'),
      ('ProcurementResultReport', 'candidates'),
      ('InspectionReport', 'photos')
  ) AS x(tbl, col)
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = NULL WHERE %I IS NOT NULL AND btrim(%I) = '''';',
      t.tbl, t.col, t.col, t.col
    );
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I IS NOT NULL AND (%I::jsonb IS NULL OR jsonb_typeof(%I::jsonb) <> ''array'');',
      t.tbl, t.col, t.col, t.col
    ) INTO bad;
    IF bad > 0 THEN
      RAISE EXCEPTION '表 % 列 % 有 % 行不是 JSON 数组，请先人工修复再迁移', t.tbl, t.col, bad;
    END IF;
  END LOOP;
END $$;

-- 2) 转类型（USING 显式转换）
ALTER TABLE "FrameworkExplanation" ALTER COLUMN "inquiryRows" TYPE JSONB USING "inquiryRows"::jsonb;
ALTER TABLE "FrameworkExplanation" ALTER COLUMN "priceCompareRows" TYPE JSONB USING "priceCompareRows"::jsonb;
ALTER TABLE "FrameworkExplanation" ALTER COLUMN "costRows" TYPE JSONB USING "costRows"::jsonb;
ALTER TABLE "FrameworkExplanation" ALTER COLUMN "attachments" TYPE JSONB USING "attachments"::jsonb;
ALTER TABLE "FrameworkExplanation" ALTER COLUMN "referenceSuppliers" TYPE JSONB USING "referenceSuppliers"::jsonb;
ALTER TABLE "PreMeetingMinutes" ALTER COLUMN "purchaseItems" TYPE JSONB USING "purchaseItems"::jsonb;
ALTER TABLE "PreMeetingMinutes" ALTER COLUMN "costRows" TYPE JSONB USING "costRows"::jsonb;
ALTER TABLE "PreMeetingMinutes" ALTER COLUMN "inquirySheets" TYPE JSONB USING "inquirySheets"::jsonb;
ALTER TABLE "ProcurementNotice" ALTER COLUMN "contacts" TYPE JSONB USING "contacts"::jsonb;
ALTER TABLE "ProcurementNotice" ALTER COLUMN "contactPhones" TYPE JSONB USING "contactPhones"::jsonb;
ALTER TABLE "ProcurementResultReport" ALTER COLUMN "suppliers" TYPE JSONB USING "suppliers"::jsonb;
ALTER TABLE "ProcurementResultReport" ALTER COLUMN "candidates" TYPE JSONB USING "candidates"::jsonb;
ALTER TABLE "InspectionReport" ALTER COLUMN "photos" TYPE JSONB USING "photos"::jsonb;
