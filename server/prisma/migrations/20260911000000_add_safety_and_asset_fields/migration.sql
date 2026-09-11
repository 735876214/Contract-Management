-- 迁移：补齐 schema 已定义但数据库缺失的字段
-- 对应模型：Contract / DailyReport / MaterialBase / AssetLedger
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `npx prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db execute` ALTER 补齐并验证；本迁移用于生产部署自动同步

-- Contract：签章操作时间
ALTER TABLE "Contract" ADD COLUMN "signedAt" TIMESTAMP(3);

-- DailyReport：是否资产 / 是否安全物资（来自物资基础库，应用层同步快照）
ALTER TABLE "DailyReport" ADD COLUMN "isAsset" TEXT;
ALTER TABLE "DailyReport" ADD COLUMN "isSafetyMaterial" TEXT;

-- MaterialBase：计量单位 / 是否资产 / 是否安全物资
ALTER TABLE "MaterialBase" ADD COLUMN "unit" TEXT;
ALTER TABLE "MaterialBase" ADD COLUMN "isAsset" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MaterialBase" ADD COLUMN "isSafetyMaterial" BOOLEAN NOT NULL DEFAULT false;

-- AssetLedger：来源收领单 ID / 明细 ID（receiptDetailId 为防重唯一键）
ALTER TABLE "AssetLedger" ADD COLUMN "receiptOrderId" TEXT;
ALTER TABLE "AssetLedger" ADD COLUMN "receiptDetailId" TEXT;
ALTER TABLE "AssetLedger" ADD CONSTRAINT "AssetLedger_receiptDetailId_key" UNIQUE ("receiptDetailId");
