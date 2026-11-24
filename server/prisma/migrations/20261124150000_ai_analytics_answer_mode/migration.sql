-- AI 助手：问答留痕复用 AiAnalyticsReport（2026-11-24 P3-A）
--
-- 决策：不新开 ChatLog 表。问答需要的字段（rawText / intentJson / factsJson /
-- unknownNumbersJson / discardedNumbersJson / markdown / source）与报告**完全一致**，
-- 只差一个「产出形态」标记。新开表等于把「事实快照 + 数字对账结果」的读写路径复制一遍，
-- 两份实现迟早漂移（本项目已经因为「同一指标在两处各算一遍」付过代价）。
--
-- 'report' = 公文式报告（sections + 表格，原有行为，默认值保证存量行不变）
-- 'chat'   = 问答（一段回答，同一套 auditNumbers 对账）

ALTER TABLE "AiAnalyticsReport" ADD COLUMN "answerMode" TEXT NOT NULL DEFAULT 'report';

-- 问答历史按 answerMode 过滤；报告历史不过滤但与 createdBy 一起走索引
CREATE INDEX "AiAnalyticsReport_createdBy_answerMode_createdAt_idx" ON "AiAnalyticsReport" ("createdBy", "answerMode", "createdAt");
