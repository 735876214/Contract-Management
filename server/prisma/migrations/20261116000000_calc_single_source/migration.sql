-- 统一计算引擎第三步 · 数据层单轨化（本项目无存量业务，直接换列）
--
-- 1) 税率统一为百分数口径（13 = 13%），字段名统一 taxRate → taxRatePct，
--    与 ContractMaterial / SettlementItem / ReceiptOrderDetail 既有口径一致。
--    此前 Contract / Invoice / DailyReport 存小数（0.13），靠 rateToPct/pctToRate 双轨换算，
--    是「同月不同合同/材料算错」的结构性根因之一。无存量数据，DROP + ADD 即可。
-- 2) 采购总清单 6 个金额/数量字段与响应保证金 Float → Decimal，消除二进制浮点误差。

-- AlterTable
ALTER TABLE "Contract" DROP COLUMN "taxRate",
ADD COLUMN     "taxRatePct" DECIMAL(9,4);

-- AlterTable
ALTER TABLE "DailyReport" DROP COLUMN "taxRate",
ADD COLUMN     "taxRatePct" DECIMAL(9,4);

-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "taxRate",
ADD COLUMN     "taxRatePct" DECIMAL(9,4);

-- AlterTable
ALTER TABLE "ReceiptOrderDetail" DROP COLUMN "taxRate",
ADD COLUMN     "taxRatePct" DECIMAL(9,4);

-- AlterTable
ALTER TABLE "ProcurementDocument" ALTER COLUMN "responseDeposit" SET DATA TYPE DECIMAL(18,2);

-- AlterTable
ALTER TABLE "ProcurementTotalItem" ALTER COLUMN "qty" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "incomePrice" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "stdCost" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "marketPrice" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "infoPrice" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "planPrice" SET DATA TYPE DECIMAL(18,4);
