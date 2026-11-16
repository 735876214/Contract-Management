import { BadRequestException } from '@nestjs/common';

/** 收口只需要这两个字段；用结构化子集，调用方不必为了传参构造完整 `JwtUser` */
export interface ProjectScopeUser {
  userId?: string | null;
  isSuperAdmin?: boolean;
}

/**
 * 项目成员收口（AI 模块共用）：超管不受成员关系限制；普通用户只能看到自己加入的项目。
 * `ai.service.ts` 与 `analysis/scm.service.ts` 都走这里，**不要再各写一份**。
 */
export function projectScopeWhere(user: ProjectScopeUser | null | undefined): Record<string, unknown> {
  if (user?.isSuperAdmin) return {};
  if (!user?.userId) throw new BadRequestException('缺少用户身份，无法校验项目权限');
  return { members: { some: { userId: user.userId } } };
}
