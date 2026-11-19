-- 采购模块权限码拆分（2026-11-19 审计 P3：权限码与模块非一一对应）
--
-- 改造前：采购工作流 4x 端点用 contract:view / contract:edit，采购模板用 template:view / template:edit。
-- 这等于「能看合同的人必然能看采购」「能改模板的人必然能改采购模板」，权限码无法按模块授予。
-- 改造后：采购自有 procurement:view / procurement:edit，采购模板自有 procurement-template:view / procurement-template:edit。
--
-- 本迁移做两件事，保证升级后没人凭空失权：
--   1) 建 4 个新权限码（幂等）；
--   2) 把「原有旧码的授权」按口径平移到新码（旧码与新码一一对应，只加不减）。

-- 1) 新权限码
INSERT INTO "Permission" ("id", "code", "name", "module", "createdAt")
VALUES
  (gen_random_uuid()::text, 'procurement:view',          '查看采购工作流', '采购管理', now()),
  (gen_random_uuid()::text, 'procurement:edit',          '维护采购工作流', '采购管理', now()),
  (gen_random_uuid()::text, 'procurement-template:view', '查看采购模板',   '采购管理', now()),
  (gen_random_uuid()::text, 'procurement-template:edit', '维护采购模板',   '采购管理', now())
ON CONFLICT ("code") DO NOTHING;

-- 2) 存量角色补授权：旧码 → 新码一对一平移
INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT gen_random_uuid()::text, rp."roleId", np."id"
FROM "RolePermission" rp
JOIN "Permission" op ON op."id" = rp."permissionId"
JOIN "Permission" np ON np."code" = CASE op."code"
    WHEN 'contract:view' THEN 'procurement:view'
    WHEN 'contract:edit' THEN 'procurement:edit'
    WHEN 'template:view' THEN 'procurement-template:view'
    WHEN 'template:edit' THEN 'procurement-template:edit'
  END
WHERE op."code" IN ('contract:view', 'contract:edit', 'template:view', 'template:edit')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
