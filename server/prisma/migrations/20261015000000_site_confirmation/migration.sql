-- ============================================================================
-- 现场确认（结算依据闸门）—— docs/09 §三
--
-- 背景：日报行（DailyReport）是结算量的唯一来源（收领单推送也会生成日报行），
-- 原先没有任何「确认」语义：谁保存谁生效，缺"由谁确认"这一环。
-- 本迁移为日报行加确认状态与确认留痕；收领单推送生成的日报行在 service 层自动置已确认。
--
-- ⚠ 存量回填为 CONFIRMED（历史数据视为已确认）：否则开启口径闸门后，
--   全部历史日报会瞬间变成"待确认"，导致关联的已结算量归零。
-- ============================================================================

-- 1) 结构变更
ALTER TABLE "DailyReport" ADD COLUMN     "confirmStatusCode" TEXT,
ADD COLUMN     "confirmRemark" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedBy" TEXT;

-- 2) 存量回填：历史日报视为「已确认」（确认人留空表示系统迁移带入，非人工确认）
UPDATE "DailyReport"
   SET "confirmStatusCode" = 'CONFIRMED',
       "confirmedAt"       = COALESCE("confirmedAt", now()),
       "confirmRemark"     = COALESCE("confirmRemark", '迁移带入：历史数据视为已确认')
 WHERE "confirmStatusCode" IS NULL;

-- 3) 索引（列表按项目 + 确认状态筛选）
CREATE INDEX "DailyReport_projectId_confirmStatusCode_idx" ON "DailyReport"("projectId", "confirmStatusCode");
