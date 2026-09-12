-- 迁移：项目信息新增「项目所在省市 / 工程地点 / 项目地址」三个位置字段
-- 对应模型：Project
-- 适用：生产库（PostgreSQL，provider = postgresql），通过 `prisma migrate deploy` 应用
-- 说明：开发库（SQLite）已通过 `prisma db push --schema prisma/schema.sqlite.prisma` 同步并验证
-- 备注：三字段均为可空文本；工程地点/项目地址已作为采购模块公共变量
--       {{工程地点}} / {{项目地址}} 的数据来源，{{项目所在省市}} 亦取自本表

ALTER TABLE "Project" ADD COLUMN "provinceCity" TEXT;
ALTER TABLE "Project" ADD COLUMN "siteLocation" TEXT;
ALTER TABLE "Project" ADD COLUMN "projectAddress" TEXT;
