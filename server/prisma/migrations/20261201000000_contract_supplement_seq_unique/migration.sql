-- 补充协议序号并发唯一（CQ 轮审计 M5）
-- 原「count+1」派生补充协议序号在并发下会生成两张同序号协议并撞编号；
-- 建唯一约束让后到者抛 P2002，写入侧据此重试取新序号（见 contract.service.create）。
-- 注意：历史脏数据（同父合同重复序号）会阻止建索引；若存在需先修数据。
CREATE UNIQUE INDEX "Contract_parentContractId_supplementSeq_key"
    ON "Contract" ("parentContractId", "supplementSeq");
