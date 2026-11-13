-- 一个合同只允许一张总结算单（业务口径）。
-- 并发 generate 时 nextCode 是「读-选」非原子：两个请求会分别拿到 `base` / `base-2`，
-- 两条都满足 (projectId, code) 唯一键、双双插入成功，同一合同出现两张总结算单。
-- 这里补 (projectId, contractId) 唯一键，让后插入者撞 P2002（generate 已把它转成 400）。

-- 先检查历史重复：宁可让迁移失败并给出数量，也不静默删掉业务单据。
DO $$
DECLARE dup_groups integer;
BEGIN
  SELECT COUNT(*) INTO dup_groups FROM (
    SELECT "projectId", "contractId"
    FROM "FinalSettlement"
    GROUP BY "projectId", "contractId"
    HAVING COUNT(*) > 1
  ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION '存在 % 组同项目同合同的重复总结算单，请先人工合并后再应用本迁移', dup_groups;
  END IF;
END $$;

-- 原普通索引被唯一索引完全覆盖，删掉避免冗余
DROP INDEX IF EXISTS "FinalSettlement_projectId_contractId_idx";

CREATE UNIQUE INDEX "FinalSettlement_projectId_contractId_key" ON "FinalSettlement"("projectId", "contractId");
