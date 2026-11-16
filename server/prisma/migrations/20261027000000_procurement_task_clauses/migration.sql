-- 采购任务的「条款选择」四个外键（业务口径 2026-10-16）。
--
-- 背景：采购发起第三步的技术质量/验收方式/付款方式，从"就地富文本录入"改为
-- **从「合同条款」库里选**（条款只在基础信息管理里维护）。四个外键用于回显"选的是哪一条"；
-- 条款正文另存快照到既有文本列 `techQuality` / `acceptanceMethod` / `paymentMethod`，
-- 这样条款库后续被改动不会改写已发布的采购文档（与"发布即定型"的语义一致）。
--
-- ⚠️ 为什么本迁移**没有**数据清洗步骤（对比 backend-conventions 的"加外键先清洗"要求）：
-- 四个列都是**本次新增的可空列**，存量行一律为 NULL，不存在空串或悬空引用；
-- 外键又是 `ON DELETE SET NULL`，条款被删时自动归 NULL，因此无需 `UPDATE ... SET NULL` 之类的前置清洗。

-- AlterTable
ALTER TABLE "ProcurementTask" ADD COLUMN     "acceptanceClauseId" TEXT,
ADD COLUMN "paymentClauseId" TEXT,
ADD COLUMN "qualityClauseId" TEXT,
ADD COLUMN "technicalClauseId" TEXT;

-- AddForeignKey
ALTER TABLE "ProcurementTask" ADD CONSTRAINT "ProcurementTask_technicalClauseId_fkey" FOREIGN KEY ("technicalClauseId") REFERENCES "Clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementTask" ADD CONSTRAINT "ProcurementTask_qualityClauseId_fkey" FOREIGN KEY ("qualityClauseId") REFERENCES "Clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementTask" ADD CONSTRAINT "ProcurementTask_paymentClauseId_fkey" FOREIGN KEY ("paymentClauseId") REFERENCES "Clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementTask" ADD CONSTRAINT "ProcurementTask_acceptanceClauseId_fkey" FOREIGN KEY ("acceptanceClauseId") REFERENCES "Clause"("id") ON DELETE SET NULL ON UPDATE CASCADE;
