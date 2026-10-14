-- 招标域结构化：投标/响应单位 + 评标记录（docs/05 §6「设计 A」的落地增量）
--
-- 背景：招标在本系统里是**采购方式**（字典 `procurement_source` 的 BID），不是平行域。
-- 成交报告的「响应单位情况汇总表」此前只以 JSON 字符串存在
-- `ProcurementResultReport.suppliers` / `candidates` 里，无法查询、统计、与供应商库/评标关联。
--
-- 本迁移**只建表**，不动任何存量数据：
-- - `ProcurementBidder`：单位级一行（报价两轮是导入表同一行的两列，故按列建模，见 schema 注释）；
-- - `ProcurementEvaluation`：评标记录，挂在 `ProcurementBidder` 上（Cascade）。
--
-- 存量 JSON → 关系表的回填**不在这里做**，而是由 `procurement-task.service.ts` 的
-- `ensureBiddersFromSnapshot()` 在首次读取成交报告/生成合同时**幂等**补齐
-- （好处：空库、存量库、重复执行三种情况同一套逻辑，无需一次性脚本，也不会因数据形态差异半途失败）。
--
-- 唯一约束 `(taskId, bidderName)`：**不能用 `(taskId, supplierId, round)`**——`supplierId` 可空，
-- 而 PostgreSQL 允许多个 NULL，那样约束对「未入库单位」等于不存在（docs/05 §6.2 草图的坑）。

-- CreateTable
CREATE TABLE "ProcurementBidder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "supplierId" TEXT,
    "bidderName" TEXT NOT NULL,
    "seq" INTEGER,
    "depositPaid" TEXT,
    "sealed" TEXT,
    "passedFirst" TEXT,
    "firstPreTaxTotal" DECIMAL(18,2),
    "firstTax" DECIMAL(18,2),
    "secondPreTaxTotal" DECIMAL(18,2),
    "secondTax" DECIMAL(18,2),
    "finalPreTaxTotal" DECIMAL(18,2),
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "bidFileUrl" TEXT,
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementBidder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementEvaluation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "evaluator" TEXT NOT NULL,
    "score" DECIMAL(9,2),
    "rank" INTEGER,
    "conclusion" TEXT,
    "comment" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcurementBidder_projectId_status_idx" ON "ProcurementBidder"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementBidder_taskId_bidderName_key" ON "ProcurementBidder"("taskId", "bidderName");

-- CreateIndex
CREATE INDEX "ProcurementEvaluation_taskId_idx" ON "ProcurementEvaluation"("taskId");

-- CreateIndex
CREATE INDEX "ProcurementEvaluation_bidderId_idx" ON "ProcurementEvaluation"("bidderId");

-- AddForeignKey
ALTER TABLE "ProcurementBidder" ADD CONSTRAINT "ProcurementBidder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementBidder" ADD CONSTRAINT "ProcurementBidder_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementBidder" ADD CONSTRAINT "ProcurementBidder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementEvaluation" ADD CONSTRAINT "ProcurementEvaluation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementEvaluation" ADD CONSTRAINT "ProcurementEvaluation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementEvaluation" ADD CONSTRAINT "ProcurementEvaluation_bidderId_fkey" FOREIGN KEY ("bidderId") REFERENCES "ProcurementBidder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
