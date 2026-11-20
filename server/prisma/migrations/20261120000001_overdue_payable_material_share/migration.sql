-- 拆期口径归一：OverduePayable.materialAmount 存「该期材料款份额」，应付款金额 = 该期材料款金额。
-- 上一迁移把旧表整笔材料款（含 paymentRatio=0.8）原样搬进了每期的 materialAmount，
-- 而引擎已改为「应付款金额 = 该期材料款金额」（不再乘一次 paymentRatio，否则比例被重复计算），
-- 因此这里把 materialAmount 乘回比例得到份额；payableAmount 本就是 材料款 × 比例，无需变动。
UPDATE "OverduePayable"
SET "materialAmount" = ROUND("materialAmount" * COALESCE("paymentRatio", 1), 2)
WHERE "paymentRatio" IS NOT NULL AND "paymentRatio" <> 1;
