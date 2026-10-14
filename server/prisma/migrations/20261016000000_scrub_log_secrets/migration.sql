-- ============================================================================
-- 一次性清洗：历史操作日志里的明文凭据与敏感标识
--
-- 背景：操作日志拦截器会把「请求参数 + 变更前后快照」整体写入 "OperationLog"，
-- 而日志页（/system/log，权限仅 system:user）可被非超管查看。
-- 2026-10-14 实测该表 495 行中存在：
--   · 35 条**明文 JWT**（/api/auth/login 的响应体被整体记录，token 有效期 7 天）；
--   · 2 条明文银行账号、2 条明文身份证号。
-- （当时唯一的脱敏是 password / oldPassword / newPassword 三个键名。）
--
-- 本迁移只做**一次性清洗**；「不再写入」由 server/src/common/utils/mask.ts 的白名单脱敏负责
-- （拦截器已改为对 params / beforeData / afterData 深度脱敏）。
--
-- 幂等：清洗后 WHERE 不再匹配，重复执行无影响。
-- ============================================================================

UPDATE "OperationLog" SET "params" = regexp_replace(regexp_replace(regexp_replace(regexp_replace(
        "params", '"token":"[^"]*"', '"token":"******"', 'g'),
        '"bankAccount":"[^"]*"', '"bankAccount":"******"', 'g'),
        '"contractAuthIdNo":"[^"]*"', '"contractAuthIdNo":"******"', 'g'),
        '"authorizedPersonIdNo":"[^"]*"', '"authorizedPersonIdNo":"******"', 'g')
 WHERE "params" ~ '"(token|bankAccount|contractAuthIdNo|authorizedPersonIdNo)":"[^"]+"';

UPDATE "OperationLog" SET "beforeData" = regexp_replace(regexp_replace(regexp_replace(regexp_replace(
        "beforeData", '"token":"[^"]*"', '"token":"******"', 'g'),
        '"bankAccount":"[^"]*"', '"bankAccount":"******"', 'g'),
        '"contractAuthIdNo":"[^"]*"', '"contractAuthIdNo":"******"', 'g'),
        '"authorizedPersonIdNo":"[^"]*"', '"authorizedPersonIdNo":"******"', 'g')
 WHERE "beforeData" ~ '"(token|bankAccount|contractAuthIdNo|authorizedPersonIdNo)":"[^"]+"';

UPDATE "OperationLog" SET "afterData" = regexp_replace(regexp_replace(regexp_replace(regexp_replace(
        "afterData", '"token":"[^"]*"', '"token":"******"', 'g'),
        '"bankAccount":"[^"]*"', '"bankAccount":"******"', 'g'),
        '"contractAuthIdNo":"[^"]*"', '"contractAuthIdNo":"******"', 'g'),
        '"authorizedPersonIdNo":"[^"]*"', '"authorizedPersonIdNo":"******"', 'g')
 WHERE "afterData" ~ '"(token|bankAccount|contractAuthIdNo|authorizedPersonIdNo)":"[^"]+"';
