-- 权限标签归一 + 超管授权按角色 code（2026-11-24 审计 P3）
--
-- 背景：20261120120000_subcontractor_other_project_libs 用随机 ID 插入了
-- subcontractor:* / other-project:* 四条权限，module 写成「分包商库 / 其他项目库」，
-- 而权限目录（server/src/constants/permissions.ts，prisma/seed.ts 与启动 seed 共用）
-- 写的是「基础信息管理」。两边的 ON CONFLICT ("code") DO NOTHING 都只是不报错，
-- 于是**谁先跑谁定义标签**：跑过 seed 的库在「角色管理」页（GET /api/system/permissions
-- 按 module 分组）看到「基础信息管理」，只跑过迁移的库看到「分包商库 / 其他项目库」。
-- 这里按目录值补齐，两边从此只有一套标签。

UPDATE "Permission" SET "name" = '查看分包商库',           "module" = '基础信息管理' WHERE "code" = 'subcontractor:view';
UPDATE "Permission" SET "name" = '维护分包商与授权委托书', "module" = '基础信息管理' WHERE "code" = 'subcontractor:edit';
UPDATE "Permission" SET "name" = '查看其他项目库',         "module" = '基础信息管理' WHERE "code" = 'other-project:view';
UPDATE "Permission" SET "name" = '维护其他项目库',         "module" = '基础信息管理' WHERE "code" = 'other-project:edit';

-- 超管补授权：按角色 code 认角色。
-- 20261120120000 里写的是 r."name" = '管理员'——角色一旦改名（或本来就是别的名字），
-- 这四条新权限对谁都不可见（菜单被 GET /api/menu 过滤掉），且没有任何报错。
INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT gen_random_uuid()::text, r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."code" = 'SUPER_ADMIN'
  AND p."code" IN ('subcontractor:view', 'subcontractor:edit', 'other-project:view', 'other-project:edit')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
