-- 日报出场日期（四域扩展按需项 2026-10-18）
ALTER TABLE "DailyReport" ADD COLUMN "exitDate" TIMESTAMP(3);
CREATE INDEX "DailyReport_exitDate_idx" ON "DailyReport"("exitDate");
