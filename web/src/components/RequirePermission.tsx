import type { ReactNode } from 'react';
import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';

/**
 * 路由级权限守卫（需求：权限不再只作用于侧边菜单）。
 *
 * - 无权限时不渲染目标页面，改为展示 403 页（**不重定向**：保留 URL 便于排查与复制给管理员）；
 * - 超级管理员直通；
 * - 后端各接口仍有 `@RequirePermissions` + `PermissionsGuard` 兜底，此处只解决「直接输 URL
 *   进入无权页面后看到空壳 + 报错」的体验问题，不是安全边界。
 *
 * 权限码来源与维护约定见 `@/constants/routePermissions`。
 */
export default function RequirePermission({
  codes,
  children,
}: {
  /** 允许进入的权限码（任一即可）；为空表示不校验 */
  codes: string[];
  children: ReactNode;
}) {
  const navigate = useNavigate();
  // 订阅 user / permissions，保证 profile 恢复后（刷新页面场景）能重新判定
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);

  const allowed =
    codes.length === 0 || !!user?.isSuperAdmin || codes.some((code) => permissions.includes(code));
  if (allowed) return <>{children}</>;

  return (
    <Result
      status="403"
      title="403"
      subTitle="当前账号没有访问该页面的权限，请联系管理员分配角色权限。"
      extra={
        <Button type="primary" onClick={() => navigate('/dashboard', { replace: true })}>
          返回工作台
        </Button>
      }
    />
  );
}
