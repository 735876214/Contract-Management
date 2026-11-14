import type { ReactNode } from 'react';
import { usePermission } from '@/hooks/usePermission';

interface CanProps {
  /** 权限码（`module:action`）；数组为 **OR** 语义（与后端 `@RequirePermissions` 一致） */
  code?: string | string[] | null;
  /** 无权限时渲染的内容（默认不渲染） */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * 操作级权限包装（2026-11-14）：把散落各页的 `{canEdit && <Button/>}` 收敛成一个组件。
 *
 * `<Can code="invoice:edit"><Button>新增</Button></Can>`
 *
 * - 只决定**显不显示**；后端 `@RequirePermissions` 仍是最终边界（点了也 403）。
 * - `code` 为空 = 不校验（等价于直接渲染 children）。
 * - 超管恒放行（由 `usePermission` 负责）。
 * - 需要同时用权限做**逻辑判断**（disabled、三元、菜单项）时，仍用 `usePermission` 判断，不要硬塞进本组件。
 */
export default function Can({ code, fallback = null, children }: CanProps) {
  const allowed = usePermission(code);
  return <>{allowed ? children : fallback}</>;
}
