import { useAuthStore } from '@/store/auth';

/**
 * 操作级权限判断（2026-11-13：「只读用户仍看到编辑按钮」修复）。
 *
 * 与路由级 `RequirePermission` 的分工：路由守卫决定"能不能进页面"，本 hook 决定
 * "页面里的编辑/新增/删除按钮显不显示"。后端各接口仍有 `@RequirePermissions` 兜底，
 * 这里只是把「点了才 403」提前成「根本不给点」。
 *
 * 用法：
 * - `usePermission('settlement:edit')` —— 单个权限码；
 * - `usePermission(['dict:edit', 'system:config'])` —— **任一命中**即放行（与后端
 *   `@RequirePermissions('dict:edit', 'system:config')` 的 OR 语义一致）；
 * - `usePermission()` / 传空数组 —— 不校验，返回 true。
 *
 * 超级管理员恒为 true（由 `hasPermission` 实现）。
 */
export function usePermission(codes?: string | string[] | null): boolean {
  // ⚠️ 必须订阅 permissions/user 本身，而不是只取 `hasPermission` 函数引用（它稳定不变）：
  // 否则登录/切换账号/刷新权限后组件不重渲染，按钮会停在旧权限上。
  const isSuperAdmin = useAuthStore((s) => !!s.user?.isSuperAdmin);
  const permissions = useAuthStore((s) => s.permissions);
  if (!codes) return true;
  const list = Array.isArray(codes) ? codes : [codes];
  const valid = list.filter(Boolean);
  if (!valid.length) return true;
  return isSuperAdmin || valid.some((code) => permissions.includes(code));
}

export default usePermission;
