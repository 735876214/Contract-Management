-- 总结算单：审减金额（经办人手工录入）；审定金额 = totalAmount − reduceAmount
ALTER TABLE "FinalSettlement" ADD COLUMN "reduceAmount" DECIMAL(18,2) DEFAULT 0;
