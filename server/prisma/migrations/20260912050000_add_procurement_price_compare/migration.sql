-- 迁移：新增「采购价格对比表」表（批次二 · 任务 3.6）
-- 对应模型：ProcurementPriceCompare（仅「单项采购」采购任务，成交报告已完成时编辑）
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db push --schema prisma/schema.sqlite.prisma` 同步并验证
-- 备注：明细表（序号 | 采购名称 | 规格型号 | 单位 | 数量 | 清单收入 | 标准成本 | 控制价 | 信息价 |
--       成交价 | 采购成本降低率 | 采购成交价下浮率 | 信息价下浮率 | 备注）的各列中，
--       除「成交价不含税单价」与「备注」为用户录入外，其余均由总采购清单（ProcurementTotalItem）
--       派生，前端计算，不落库；items 仅保存每行的成交价与备注（按 materialBaseId 归位）。

CREATE TABLE "ProcurementPriceCompare" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "taskId"          TEXT NOT NULL,
  "pricingMethod"   TEXT,
  "benefitAnalysis" TEXT,
  "items"           TEXT,
  "publishedAt"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version"         INTEGER NOT NULL DEFAULT 0,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProcurementPriceCompare_pkey" PRIMARY KEY ("id")
);

-- 一个采购任务仅一份采购价格对比表
CREATE UNIQUE INDEX "ProcurementPriceCompare_taskId_key" ON "ProcurementPriceCompare"("taskId");
CREATE INDEX "ProcurementPriceCompare_projectId_idx" ON "ProcurementPriceCompare"("projectId");

ALTER TABLE "ProcurementPriceCompare"
  ADD CONSTRAINT "ProcurementPriceCompare_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProcurementPriceCompare"
  ADD CONSTRAINT "ProcurementPriceCompare_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
