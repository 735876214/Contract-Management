-- 彻底移除部门功能：删除部门表及用户表上的部门外键
DROP TABLE IF EXISTS "Dept";
ALTER TABLE "User" DROP COLUMN IF EXISTS "deptId";
