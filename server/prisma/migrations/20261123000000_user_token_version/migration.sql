-- 用户令牌版本（2026-11-23 第 24 轮审计）
--
-- 背景：JWT 有效期 7 天且**没有任何吊销手段** —— 改密码、管理员重置密码之后，
-- 旧 token 仍然能用到自然过期（「改密即下线」依赖前端自觉清 localStorage，不是服务端约束）。
--
-- 做法：`User.tokenVersion` 作为令牌版本号，JWT 载荷里带 `tv`，
-- `JwtStrategy.validate()` 每次请求比对「token.tv == user.tokenVersion」，
-- 不一致即 401。改密 / 重置密码 / 停用账号时 +1。
--
-- 兼容性：默认 0，且上线前签发的存量 token 没有 `tv`（按 0 处理）——
-- 因此本迁移**不会**让任何在线的用户掉线。
--
-- 纯新增列，无回填、无外键、无数据清洗需求（ALTER 自带 DEFAULT 即完成回填）。

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
