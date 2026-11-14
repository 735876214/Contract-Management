import { BadRequestException } from '@nestjs/common';
import type { JwtUser } from '../../../common/decorators/user.decorator';

/**
 * 项目成员收口（AI 模块共用）：超管不受成员关系限制；普通用户只能看到自己加入的项目。
 * 与 `analysis/scm.service.ts` 的 `projectWhere.members` 同一口径。
 */
export function projectScopeWhere(user: JwtUser): Record<string, unknown> {
  if (user?.isSuperAdmin) return {};
  if (!user?.userId) throw new BadRequestException('缺少用户身份，无法校验项目权限');
  return { members: { some: { userId: user.userId } } };
}
