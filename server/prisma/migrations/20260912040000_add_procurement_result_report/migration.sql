-- 迁移：新增「成交报告」表（批次二 · 任务 3.5）
-- 对应模型：ProcurementResultReport（仅「单项采购」采购任务，采购文件已完成时编辑）
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db push --schema prisma/schema.sqlite.prisma` 同步并验证
-- 备注：四张表（响应单位情况汇总表 / 开启报价情况表 / 第二轮报价情况表 / 拟推荐成交候选人表）
--       均由 suppliers（导入的响应单位明细）与 candidates（勾选结果）派生，不单独落库；
--       「预计采购金额」来自总采购清单（ProcurementTotalItem），亦不落库。

CREATE TABLE "ProcurementResultReport" (
  "id"               TEXT NOT NULL,
  "projectId"        TEXT NOT NULL,
  "taskId"           TEXT NOT NULL,
  "unitCount"        INTEGER,
  "openTime"         TIMESTAMP(3),
  "openPlace"        TEXT,
  "reviewMembers"    TEXT,
  "approvedCount"    INTEGER,
  "participantCount" INTEGER,
  "abstainCount"     INTEGER,
  "validFileCount"   INTEGER,
  "suppliers"        TEXT,
  "candidates"       TEXT,
  "publishedAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version"          INTEGER NOT NULL DEFAULT 0,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProcurementResultReport_pkey" PRIMARY KEY ("id")
);

-- 一个采购任务仅一份成交报告
CREATE UNIQUE INDEX "ProcurementResultReport_taskId_key" ON "ProcurementResultReport"("taskId");
CREATE INDEX "ProcurementResultReport_projectId_idx" ON "ProcurementResultReport"("projectId");

ALTER TABLE "ProcurementResultReport"
  ADD CONSTRAINT "ProcurementResultReport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProcurementResultReport"
  ADD CONSTRAINT "ProcurementResultReport_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
