-- 迁移：框架协议事前说明新增「引用供应商及金额」字段（问题五）
-- 对应模型：FrameworkExplanation.referenceSuppliers
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db push --schema prisma/schema.sqlite.prisma` 同步并验证
-- 备注：引用供应商及金额以 JSON 数组保存 [{ supplier, amount }]，
--       支持多行手动维护，并可从「询价情况表」（inquiryRows）自动填充报价最低的单位与金额。

ALTER TABLE "FrameworkExplanation" ADD COLUMN "referenceSuppliers" TEXT;
