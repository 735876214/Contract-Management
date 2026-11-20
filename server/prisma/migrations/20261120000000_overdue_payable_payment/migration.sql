-- 逾期利息台账重构：单表「一行 = 一期或一笔付款」→ 主子表
--   主表 OverduePayable ：一行 = 一个结算月份内的一期应付款项（仅材料款计息）
--   子表 OverduePayment ：付款流水（跨期自动分配，不绑定某一期）
-- 搬迁规则：materialAmount > 0 的行 → OverduePayable；paymentAmount > 0 的行 → OverduePayment；
--          其余「计息承载行」（材料款与付款皆空）丢弃 —— 未付余额利息改由服务端按主子表重算并直接挂在期上。
-- 派生列（payableAmount / overdueStartDate / interestAmount / overdueDays / monthlyRate / overdueInterest）
-- 迁移后由服务端重算回写，此处先原样搬运以保留历史快照。

CREATE TABLE "OverduePayable" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "settlementMonth" TEXT NOT NULL,
    "periodSeq" INTEGER NOT NULL DEFAULT 1,
    "materialAmount" DECIMAL(18,2),
    "paymentRatio" DECIMAL(9,4),
    "payableAmount" DECIMAL(18,2),
    "payableDate" TIMESTAMP(3),
    "overdueStartDate" TIMESTAMP(3),
    "interestAmount" DECIMAL(18,2),
    "overdueDays" INTEGER,
    "monthlyRate" DECIMAL(18,6),
    "overdueInterest" DECIMAL(18,2),
    "waived" BOOLEAN NOT NULL DEFAULT false,
    "prevCumulative" DECIMAL(18,2),
    "remark" TEXT,
    "isSettlementPeriod" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OverduePayable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OverduePayment" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "paymentAmount" DECIMAL(18,2) NOT NULL,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OverduePayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OverduePayable_contractId_settlementMonth_idx" ON "OverduePayable"("contractId", "settlementMonth");
CREATE INDEX "OverduePayment_contractId_paymentDate_idx" ON "OverduePayment"("contractId", "paymentDate");

ALTER TABLE "OverduePayable" ADD CONSTRAINT "OverduePayable_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OverduePayment" ADD CONSTRAINT "OverduePayment_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 应付款项：材料款行
INSERT INTO "OverduePayable" (
    "id", "contractId", "settlementMonth", "periodSeq", "materialAmount", "paymentRatio",
    "payableAmount", "payableDate", "overdueStartDate", "interestAmount", "overdueDays",
    "monthlyRate", "overdueInterest", "waived", "prevCumulative", "remark",
    "isSettlementPeriod", "createdAt", "version", "updatedAt"
)
SELECT
    o."id", o."contractId", o."settlementMonth",
    CASE WHEN o."periodSeq" > 0 THEN o."periodSeq" ELSE 1 END,
    o."materialAmount", o."paymentRatio",
    o."payableAmount", o."payableDate", o."overdueStartDate",
    NULL, NULL,
    o."monthlyRate", COALESCE(o."overdueInterest", 0), o."waived", o."prevCumulative", o."remark",
    o."isSettlementPeriod", o."createdAt", o."version", NOW()
FROM "OverdueInterest" o
WHERE o."materialAmount" IS NOT NULL AND o."materialAmount" > 0;

-- 付款流水：有实际付款日与付款金额的行
INSERT INTO "OverduePayment" (
    "id", "contractId", "paymentDate", "paymentAmount", "remark", "createdAt", "version", "updatedAt"
)
SELECT
    o."id", o."contractId", o."paymentDate", o."paymentAmount", o."remark",
    o."createdAt", o."version", NOW()
FROM "OverdueInterest" o
WHERE o."paymentAmount" IS NOT NULL AND o."paymentAmount" > 0 AND o."paymentDate" IS NOT NULL;

DROP TABLE "OverdueInterest";
