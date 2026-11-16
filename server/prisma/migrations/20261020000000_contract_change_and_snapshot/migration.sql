-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "changeAmount" DECIMAL(18,2),
ADD COLUMN     "changeEffectiveDate" TIMESTAMP(3),
ADD COLUMN     "changeQty" DECIMAL(18,2),
ADD COLUMN     "supplierSnapshot" TEXT;

-- 存量补充协议回填 changeAmount = amount。
-- 理由：结构化增量需要"补充协议清单 + 主合同清单"才能按算法重算，而存量补充协议**可能没有清单行**
-- （界面允许只填表单/正文），此时无法反推差额。按原 amount 迁移可保证"合同当前金额"不因本次改造
-- 而突然缩水（防超结上限跟着变小 = 拦住原本合法的单据）；这些记录在下一次保存清单时会按
-- common/utils/supplement-delta.ts 重算为真正的带符号增量。
UPDATE "Contract"
SET "changeAmount" = "amount"
WHERE "isSupplement" = 'Y' AND "changeAmount" IS NULL AND "amount" IS NOT NULL;
