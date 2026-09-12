-- 迁移：新增「采购文件」表（批次二 · 任务 3.4）
-- 对应模型：ProcurementDocument（仅「单项采购」采购任务，采购公告已完成时编辑）
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db push --schema prisma/schema.sqlite.prisma` 同步并验证
-- 备注：采购清单不落库，始终从「总采购清单」（ProcurementTotalItem）派生；
--       物资名称/规格型号/计量单位/暂定数量/备注来自总清单，税前单价/税率/综合单价/合价留空（由投标方填写）

CREATE TABLE "ProcurementDocument" (
  "id"               TEXT NOT NULL,
  "projectId"        TEXT NOT NULL,
  "taskId"           TEXT NOT NULL,
  "procurementTime"  TIMESTAMP(3),
  "responseDeposit"  DOUBLE PRECISION,
  "quoteDescription" TEXT,
  "publishedAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version"          INTEGER NOT NULL DEFAULT 0,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProcurementDocument_pkey" PRIMARY KEY ("id")
);

-- 一个采购任务仅一份采购文件
CREATE UNIQUE INDEX "ProcurementDocument_taskId_key" ON "ProcurementDocument"("taskId");
CREATE INDEX "ProcurementDocument_projectId_idx" ON "ProcurementDocument"("projectId");

ALTER TABLE "ProcurementDocument"
  ADD CONSTRAINT "ProcurementDocument_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProcurementDocument"
  ADD CONSTRAINT "ProcurementDocument_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
