import { ForbiddenException } from '@nestjs/common';

/**
 * 按**动作**校验权限（而不是按路由）。
 *
 * 背景（2026-10-20 审计 P1-2）：`@RequirePermissions` 是 **OR** 语义
 * （`server/src/modules/auth/guards/permissions.guard.ts` 里 `required.some(...)`），
 * 一个接口挂多个码，只要命中一个就能进。像「AI 文件登记确认」这种一个请求里做两件事
 * （建合同 + 可能建供应商）的接口，守卫层没法表达「按实际动作分别校验」，
 * 只能在 service 里对增量的那个动作再判一次。
 *
 * 用法：进入有副作用的动作之前调用；`user` 就是 `@CurrentUser()` 拿到的 `JwtUser`。
 */
export function assertPermission(user: any, code: string, message?: string): void {
  if (user?.isSuperAdmin) return;
  const list: string[] = Array.isArray(user?.permissions) ? user.permissions : [];
  if (list.includes(code)) return;
  throw new ForbiddenException(message || `缺少权限：${code}`);
}
